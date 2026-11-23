import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import { lockOrder, transitionOrder } from '../orders/order-transitions.js';
import {
  commitReservations,
  releaseReservations,
} from '../orders/stock-reservations.js';

const PAY_ACTOR = { type: 'payment', id: null } as const;

export interface CapturedPayment {
  id: string;
  method: string | null;
}

/**
 * Makes a confirmed, captured Razorpay payment real: the transaction is captured, the order is paid and confirmed, and its
 * stock is sold. This is the ONE place that does it, used by the shopper's confirmation, the Razorpay webhook and the
 * reconciliation job, so they can never disagree and any of them may run twice or at the same time.
 *
 * The caller has already confirmed with Razorpay (signature and a direct lookup, or an authenticated webhook) and checked the
 * amount, currency and Razorpay order. Everything here runs in the caller's transaction, under locks on the order and the
 * transaction row, and is idempotent: a payment that is already captured returns 'already'.
 */
export async function settleCapturedPayment(
  tx: DbTx,
  tenantId: string,
  paymentTransactionId: string,
  payment: CapturedPayment,
): Promise<'applied' | 'already'> {
  const row = rowsOf<{ order_id: string; status: string }>(
    await tx.execute(sql`
      select order_id, status from public.payment_transactions
      where id = ${paymentTransactionId}::uuid and tenant_id = ${tenantId}::uuid for update`),
  )[0];
  if (!row) throw new Error('payment transaction not found');
  if (row.status === 'captured') return 'already';

  const order = await lockOrder(tx, tenantId, row.order_id);
  await tx.execute(sql`
    update public.payment_transactions set status = 'captured', razorpay_payment_id = ${payment.id}, method = ${payment.method},
      failure_code = null, failure_description = null, captured_at = now(), updated_at = now()
    where id = ${paymentTransactionId}::uuid`);
  await tx.execute(sql`
    update public.orders set payment_status = 'paid', updated_at = now()
    where id = ${order.id}::uuid and tenant_id = ${tenantId}::uuid`);

  const flagRefund = () =>
    tx.execute(sql`
      update public.payment_transactions set refund_required = true, updated_at = now()
      where id = ${paymentTransactionId}::uuid`);

  if (order.status !== 'pending_payment') {
    // The order was already closed (the hold expired and the cleanup job cancelled it) but the money arrived.
    await flagRefund();
    return 'applied';
  }
  try {
    // A savepoint: if the stock is gone, the partial work of commitReservations is undone before we decide what to do.
    await tx.transaction((inner) =>
      commitReservations(inner, tenantId, order.id, order.orderNumber),
    );
    await transitionOrder(
      tx,
      tenantId,
      order.id,
      'confirmed',
      PAY_ACTOR,
      'Payment received',
    );
  } catch (error) {
    if (!(error instanceof AppException && error.code === 'RESERVATION_LOST'))
      throw error;
    await transitionOrder(
      tx,
      tenantId,
      order.id,
      'cancelled',
      PAY_ACTOR,
      'Paid, but the items sold out first. A refund is due',
    );
    await releaseReservations(tx, tenantId, order.id, 'released');
    await flagRefund();
  }
  return 'applied';
}
