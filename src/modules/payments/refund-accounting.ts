import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type { RazorpayRefund } from './razorpay.client.js';

/** Razorpay's refund state, in our words. A refund Razorpay has accepted but not finished counts as still processing. */
export function refundStatusFrom(
  razorpayStatus: string,
): 'processing' | 'processed' | 'failed' {
  if (razorpayStatus === 'processed') return 'processed';
  if (razorpayStatus === 'failed') return 'failed';
  return 'processing';
}

/**
 * Brings the payment transaction and its order in line with its refunds, inside the caller's transaction:
 *  - the order's payment status: `paid` (nothing refunded), `partially_refunded`, or `refunded` once the whole captured amount
 *    is refunded or on its way. Pending and processing refunds count (the money is already committed to going back), failed
 *    ones do not, so a failed refund restores the order to what it was;
 *  - the refund flag: a payment that had to be flagged for refund (paid, but the items were gone) is cleared once the whole
 *    amount has really been refunded.
 */
export async function recomputeRefundState(
  tx: DbTx,
  tenantId: string,
  paymentTransactionId: string,
): Promise<void> {
  const row = rowsOf<{
    order_id: string;
    status: string;
    provider: string;
    amount_minor: number;
    committed: number;
    processed: number;
    refund_required: boolean;
  }>(
    await tx.execute(sql`
      select t.order_id, t.status, t.provider, t.amount_minor::float8 as amount_minor, t.refund_required,
        coalesce((select sum(r.amount_minor) from public.refunds r
                  where r.payment_transaction_id = t.id and r.status in ('pending', 'processing', 'processed')), 0)::float8 as committed,
        coalesce((select sum(r.amount_minor) from public.refunds r
                  where r.payment_transaction_id = t.id and r.status = 'processed'), 0)::float8 as processed
      from public.payment_transactions t
      where t.id = ${paymentTransactionId}::uuid and t.tenant_id = ${tenantId}::uuid`),
  )[0];
  if (!row || row.provider !== 'razorpay' || row.status !== 'captured') return;
  const amount = Number(row.amount_minor);
  const committed = Number(row.committed);
  const paymentStatus =
    committed <= 0
      ? 'paid'
      : committed >= amount
        ? 'refunded'
        : 'partially_refunded';
  await tx.execute(sql`
    update public.orders set payment_status = ${paymentStatus}, updated_at = now()
    where id = ${row.order_id}::uuid and tenant_id = ${tenantId}::uuid and payment_status <> ${paymentStatus}`);
  if (row.refund_required && Number(row.processed) >= amount)
    await tx.execute(sql`
      update public.payment_transactions set refund_required = false, updated_at = now()
      where id = ${paymentTransactionId}::uuid`);
}

/** Records Razorpay's view of a refund on our row, then re-derives the order's payment status. */
export async function applyRefundState(
  tx: DbTx,
  tenantId: string,
  refundId: string,
  remote: Pick<RazorpayRefund, 'id' | 'status'>,
): Promise<void> {
  const status = refundStatusFrom(remote.status);
  const row = rowsOf<{ payment_transaction_id: string }>(
    await tx.execute(sql`
      update public.refunds set
        razorpay_refund_id = coalesce(razorpay_refund_id, ${remote.id}),
        status = case when status = 'processed' then status else ${status} end,
        processed_at = case when ${status} = 'processed' and processed_at is null then now() else processed_at end,
        failure_reason = case when ${status} = 'failed' then 'Razorpay could not complete this refund.' else null end,
        updated_at = now()
      where id = ${refundId}::uuid and tenant_id = ${tenantId}::uuid
      returning payment_transaction_id`),
  )[0];
  if (row) await recomputeRefundState(tx, tenantId, row.payment_transaction_id);
}
