import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { notFound } from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { likeTerm, offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import type { RefundDto } from './refunds.dto.js';
import type {
  TransactionDetailDto,
  TransactionListQueryDto,
} from './transactions.dto.js';

type Row = Record<string, unknown>;

const REFUNDED = sql`coalesce(r.refunded, 0)`;
const PENDING = sql`coalesce(r.pending, 0)`;

/** Per-transaction refund totals, computed once per row. */
const REFUND_JOIN = sql`left join lateral (
    select sum(amount_minor) filter (where status = 'processed')::float8 as refunded,
           sum(amount_minor) filter (where status in ('pending', 'processing'))::float8 as pending
    from public.refunds where payment_transaction_id = t.id) r on true`;

const refundStatusOf = (amount: number, refunded: number, pending: number) =>
  pending > 0
    ? 'pending'
    : refunded >= amount
      ? 'full'
      : refunded > 0
        ? 'partial'
        : 'none';

const toDto = (r: Row) => {
  const amount = Number(r.amount_minor);
  const refunded = Number(r.refunded_minor);
  const pending = Number(r.pending_minor);
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    orderNumber: r.order_number as number,
    provider: r.provider as string,
    status: r.status as string,
    amountMinor: amount,
    currency: r.currency as string,
    method: (r.method as string | null) ?? null,
    razorpayOrderId: (r.razorpay_order_id as string | null) ?? null,
    razorpayPaymentId: (r.razorpay_payment_id as string | null) ?? null,
    refundedMinor: refunded,
    refundPendingMinor: pending,
    refundStatus: refundStatusOf(amount, refunded, pending),
    refundRequired: r.refund_required as boolean,
    createdAt: new Date(r.created_at as string),
    capturedAt: r.captured_at ? new Date(r.captured_at as string) : null,
    collectedAt: r.collected_at ? new Date(r.collected_at as string) : null,
  };
};

const SELECT = sql`t.id, t.order_id, o.order_number, t.provider, t.status, t.amount_minor::float8 as amount_minor, t.currency, t.method,
  t.razorpay_order_id, t.razorpay_payment_id, t.refund_required, t.created_at, t.captured_at, t.collected_at,
  ${REFUNDED} as refunded_minor, ${PENDING} as pending_minor`;

/** The Owner's payment history: online and COD, searchable and filterable. Reads run as the signed-in user (RLS applies). */
@Injectable()
export class TransactionsService {
  constructor(private readonly db: DatabaseService) {}

  list(org: OrgContext, q: TransactionListQueryDto) {
    const term = q.search ? likeTerm(q.search) : null;
    const where = sql`where t.tenant_id = ${org.tenantId}::uuid
      ${q.status ? sql`and t.status = ${q.status}` : sql``}
      ${q.provider ? sql`and t.provider = ${q.provider}` : sql``}
      ${q.method ? sql`and t.method = ${q.method}` : sql``}
      ${q.from ? sql`and t.created_at >= ${q.from}::timestamptz` : sql``}
      ${q.to ? sql`and t.created_at <= ${q.to}::timestamptz` : sql``}
      ${
        q.refundStatus === 'none'
          ? sql`and ${REFUNDED} = 0 and ${PENDING} = 0`
          : q.refundStatus === 'pending'
            ? sql`and ${PENDING} > 0`
            : q.refundStatus === 'partial'
              ? sql`and ${PENDING} = 0 and ${REFUNDED} > 0 and ${REFUNDED} < t.amount_minor`
              : q.refundStatus === 'full'
                ? sql`and ${PENDING} = 0 and ${REFUNDED} >= t.amount_minor`
                : sql``
      }
      ${term ? sql`and (o.order_number::text ilike ${term} or t.id::text ilike ${term} or t.razorpay_order_id ilike ${term} or t.razorpay_payment_id ilike ${term})` : sql``}`;
    const from = sql`from public.payment_transactions t join public.orders o on o.id = t.order_id and o.tenant_id = t.tenant_id ${REFUND_JOIN}`;
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<Row>(
        await tx.execute(sql`
          select ${SELECT} ${from} ${where}
          order by t.created_at ${q.sortOrder === 'asc' ? sql`asc` : sql`desc`}, t.id
          limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const total = rowsOf<{ n: number }>(
        await tx.execute(sql`select count(*)::int as n ${from} ${where}`),
      )[0].n;
      return new Paginated(rows.map(toDto), {
        page: q.page,
        limit: q.limit,
        total,
      });
    });
  }

  get(org: OrgContext, id: string): Promise<TransactionDetailDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const t = rowsOf<Row>(
        await tx.execute(sql`
          select ${SELECT}, t.attempts, t.failure_code, t.failure_description
          from public.payment_transactions t join public.orders o on o.id = t.order_id and o.tenant_id = t.tenant_id ${REFUND_JOIN}
          where t.tenant_id = ${org.tenantId}::uuid and t.id = ${id}::uuid`),
      )[0];
      if (!t) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');
      const refunds = rowsOf<Row>(
        await tx.execute(sql`
          select r.id, r.order_id, r.payment_transaction_id, r.amount_minor::float8 as amount_minor, r.currency, r.status, r.reason,
            r.source, r.razorpay_refund_id, r.failure_reason, r.created_at, r.processed_at
          from public.refunds r where r.tenant_id = ${org.tenantId}::uuid and r.payment_transaction_id = ${id}::uuid order by r.created_at`),
      );
      const events = t.razorpay_order_id
        ? rowsOf<Row>(
            await tx.execute(sql`
              select event_id, event_type, status, note, received_at from public.payment_webhook_events
              where tenant_id = ${org.tenantId}::uuid and razorpay_order_id = ${t.razorpay_order_id as string}
              order by received_at, id`),
          )
        : [];
      const refundDtos: RefundDto[] = refunds.map((r) => ({
        id: r.id as string,
        orderId: r.order_id as string,
        orderNumber: t.order_number as number,
        paymentTransactionId: r.payment_transaction_id as string,
        amountMinor: Number(r.amount_minor),
        currency: r.currency as string,
        status: r.status as string,
        reason: (r.reason as string | null) ?? null,
        source: r.source as string,
        razorpayRefundId: (r.razorpay_refund_id as string | null) ?? null,
        failureReason: (r.failure_reason as string | null) ?? null,
        createdAt: new Date(r.created_at as string),
        processedAt: r.processed_at ? new Date(r.processed_at as string) : null,
      }));
      return {
        ...toDto(t),
        attempts: t.attempts as number,
        failureCode: (t.failure_code as string | null) ?? null,
        failureDescription: (t.failure_description as string | null) ?? null,
        refunds: refundDtos,
        events: events.map((e) => ({
          eventId: e.event_id as string,
          eventType: e.event_type as string,
          status: e.status as string,
          note: (e.note as string | null) ?? null,
          receivedAt: new Date(e.received_at as string),
        })),
      };
    });
  }
}
