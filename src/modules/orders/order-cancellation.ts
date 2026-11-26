import { sql } from 'drizzle-orm';
import { conflict } from '../../common/app.exception.js';
import type { DbTx } from '../../database/database.service.js';
import {
  assertNoOpenShipment,
  lockOrder,
  transitionOrder,
  type OrderActor,
} from './order-transitions.js';
import { releaseReservations, restockCommitted } from './stock-reservations.js';

/**
 * Cancels an order and puts its stock back: holds that were never paid are released, units that were already sold are
 * returned to the shelf with a ledger entry. One transaction, owned by the caller.
 *
 * An order whose money was actually received (an online payment captured, or COD cash collected) cannot be cancelled here:
 * the money has to be refunded first, which is the payments module's job. That check is explicit rather than silent.
 */
export async function cancelOrder(
  tx: DbTx,
  tenantId: string,
  orderId: string,
  actor: OrderActor,
  reason: string,
): Promise<void> {
  const order = await lockOrder(tx, tenantId, orderId);
  await assertNoOpenShipment(tx, tenantId, orderId);
  if (['paid', 'collected', 'partially_refunded'].includes(order.paymentStatus))
    throw conflict(
      'This order has been paid. Refund the payment before cancelling it.',
      undefined,
      'REFUND_REQUIRED',
    );
  await transitionOrder(tx, tenantId, orderId, 'cancelled', actor, reason);
  // A COD order that was waiting for cash will never collect any.
  await tx.execute(sql`
    update public.orders set payment_status = 'unpaid', updated_at = now()
    where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid and payment_status = 'pending_collection'`);
  // Nothing was paid, so any open payment attempt ends with the order. (A payment the customer authorised but that was
  // never captured is left alone: Razorpay releases uncaptured authorisations by itself.)
  await tx.execute(sql`
    update public.payment_transactions set status = 'cancelled', updated_at = now()
    where order_id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid
      and status in ('created', 'failed', 'pending_collection')`);
  await releaseReservations(tx, tenantId, orderId, 'released');
  await restockCommitted(tx, tenantId, orderId, order.orderNumber);
}
