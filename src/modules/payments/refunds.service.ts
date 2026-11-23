import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { offsetOf } from '../../common/dto/pagination-query.dto.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import type { RefundDto, RefundListQueryDto } from './refunds.dto.js';
import { PAYMENTS_UNAVAILABLE_MESSAGE } from './payments.service.js';
import {
  RazorpayClient,
  RazorpayError,
  type RazorpayRefund,
} from './razorpay.client.js';
import {
  loadRazorpayAccount,
  type RazorpayAccount,
} from './razorpay-credentials.js';
import { applyRefundState, recomputeRefundState } from './refund-accounting.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

interface RefundRow {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_transaction_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  reason: string | null;
  source: string;
  razorpay_refund_id: string | null;
  failure_reason: string | null;
  created_at: string | Date;
  processed_at: string | Date | null;
}

const COLUMNS = sql`r.id, r.tenant_id, r.order_id, r.payment_transaction_id, r.amount_minor::float8 as amount_minor, r.currency,
  r.status, r.reason, r.source, r.razorpay_refund_id, r.failure_reason, r.created_at, r.processed_at`;

const toDto = (r: RefundRow, orderNumber: number): RefundDto => ({
  id: r.id,
  orderId: r.order_id,
  orderNumber,
  paymentTransactionId: r.payment_transaction_id,
  amountMinor: Number(r.amount_minor),
  currency: r.currency,
  status: r.status,
  reason: r.reason,
  source: r.source,
  razorpayRefundId: r.razorpay_refund_id,
  failureReason: r.failure_reason,
  createdAt: new Date(r.created_at),
  processedAt: r.processed_at ? new Date(r.processed_at) : null,
});

/**
 * Refunds of online (Razorpay) payments. Owner only; the controller guards it and every query is pinned to the caller's tenant.
 *
 * The order of events is what prevents a double or excess refund: under a lock on the payment transaction, the refundable
 * amount is computed and a 'pending' refund row is inserted; only then is Razorpay called, with the row's own id as the
 * `receipt`. If the outcome of the call is unknown (timeout), the refund is looked up by that receipt before anything is sent
 * again, so a refund is never created twice.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly client: RazorpayClient,
  ) {}

  async create(
    org: OrgContext,
    transactionId: string,
    dto: { amountMinor?: number; reason: string },
    idempotencyKey: string | undefined,
  ): Promise<RefundDto> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw invalid(
        'Send an Idempotency-Key header of 8 to 128 letters, numbers, dashes or underscores.',
        undefined,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
    const refundId = await this.db.withCheckout(org.tenantId, async (tx) => {
      const t = rowsOf<{
        id: string;
        order_id: string;
        provider: string;
        status: string;
        amount_minor: number;
        currency: string;
        razorpay_payment_id: string | null;
      }>(
        await tx.execute(sql`
          select id, order_id, provider, status, amount_minor::float8 as amount_minor, currency, razorpay_payment_id
          from public.payment_transactions where id = ${transactionId}::uuid and tenant_id = ${org.tenantId}::uuid for update`),
      )[0];
      if (!t) throw notFound('Transaction not found.', 'TRANSACTION_NOT_FOUND');

      const existing = rowsOf<{
        id: string;
        payment_transaction_id: string;
        amount_minor: number;
      }>(
        await tx.execute(sql`
          select id, payment_transaction_id, amount_minor::float8 as amount_minor from public.refunds
          where tenant_id = ${org.tenantId}::uuid and idempotency_key = ${idempotencyKey}`),
      )[0];
      if (existing) {
        if (
          existing.payment_transaction_id !== t.id ||
          (dto.amountMinor !== undefined &&
            Number(existing.amount_minor) !== dto.amountMinor)
        )
          throw conflict(
            'This Idempotency-Key was already used for a different refund.',
            undefined,
            'IDEMPOTENCY_KEY_REUSED',
          );
        return existing.id;
      }

      if (t.provider !== 'razorpay')
        throw conflict(
          'Cash on delivery payments are refunded outside the system, directly to the customer.',
          undefined,
          'COD_REFUND_MANUAL',
        );
      if (t.status !== 'captured' || !t.razorpay_payment_id)
        throw conflict(
          'Only a payment that was received can be refunded.',
          undefined,
          'NOT_REFUNDABLE',
        );

      const committed = Number(
        rowsOf<{ s: number }>(
          await tx.execute(sql`
            select coalesce(sum(amount_minor), 0)::float8 as s from public.refunds
            where payment_transaction_id = ${t.id}::uuid and status in ('pending', 'processing', 'processed')`),
        )[0].s,
      );
      const refundable = Number(t.amount_minor) - committed;
      const amount = dto.amountMinor ?? refundable;
      if (amount < 1)
        throw conflict(
          'This payment has already been refunded in full.',
          undefined,
          'NOTHING_TO_REFUND',
        );
      if (amount > refundable)
        throw new AppException(
          'CONFLICT',
          'That is more than can still be refunded for this payment.',
          {
            code: 'REFUND_EXCEEDS_PAYMENT',
            details: { refundableMinor: refundable },
          },
        );

      const id = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.refunds (tenant_id, order_id, payment_transaction_id, amount_minor, currency, reason, idempotency_key, requested_by)
          values (${org.tenantId}::uuid, ${t.order_id}::uuid, ${t.id}::uuid, ${amount}, ${t.currency}, ${dto.reason}, ${idempotencyKey}, ${org.userId}::uuid)
          returning id`),
      )[0].id;
      await recomputeRefundState(tx, org.tenantId, t.id);
      return id;
    });
    return this.drive(org.tenantId, refundId);
  }

  async list(org: OrgContext, q: RefundListQueryDto) {
    const where = sql`where r.tenant_id = ${org.tenantId}::uuid ${q.status ? sql`and r.status = ${q.status}` : sql``}`;
    return this.db.withUser(org.userId, async (tx) => {
      const rows = rowsOf<RefundRow & { order_number: number }>(
        await tx.execute(sql`
          select ${COLUMNS}, o.order_number from public.refunds r join public.orders o on o.id = r.order_id and o.tenant_id = r.tenant_id
          ${where} order by r.created_at ${q.sortOrder === 'asc' ? sql`asc` : sql`desc`}, r.id
          limit ${q.limit} offset ${offsetOf(q)}`),
      );
      const total = rowsOf<{ n: number }>(
        await tx.execute(
          sql`select count(*)::int as n from public.refunds r ${where}`,
        ),
      )[0].n;
      return new Paginated(
        rows.map((r) => toDto(r, r.order_number)),
        { page: q.page, limit: q.limit, total },
      );
    });
  }

  /** Asks Razorpay where a refund stands (or finishes sending one whose outcome was unclear). */
  async sync(org: OrgContext, refundId: string): Promise<RefundDto> {
    return this.drive(org.tenantId, refundId);
  }

  /**
   * Moves one refund as far as Razorpay allows. Safe to call repeatedly and from the reconciliation job. It reads state, calls
   * Razorpay with no database transaction open, then records the result in a fresh transaction.
   */
  async drive(tenantId: string, refundId: string): Promise<RefundDto> {
    const ctx = await this.db.withCheckout(tenantId, async (tx) => {
      const refund = rowsOf<
        RefundRow & { order_number: number; razorpay_payment_id: string | null }
      >(
        await tx.execute(sql`
          select ${COLUMNS}, o.order_number, t.razorpay_payment_id
          from public.refunds r
          join public.orders o on o.id = r.order_id and o.tenant_id = r.tenant_id
          join public.payment_transactions t on t.id = r.payment_transaction_id and t.tenant_id = r.tenant_id
          where r.id = ${refundId}::uuid and r.tenant_id = ${tenantId}::uuid`),
      )[0];
      if (!refund) throw notFound('Refund not found.', 'REFUND_NOT_FOUND');
      if (refund.status === 'processed' || refund.status === 'failed')
        return { refund, account: null };
      return { refund, account: await this.account(tx, tenantId) };
    });
    const { refund, account } = ctx;
    if (!account || !refund.razorpay_payment_id)
      return toDto(refund, refund.order_number);

    let remote: RazorpayRefund;
    try {
      if (refund.razorpay_refund_id) {
        remote = await this.client.fetchRefund(
          account,
          refund.razorpay_refund_id,
        );
      } else {
        // Never send twice: if an earlier, unconfirmed attempt reached Razorpay it is found by its receipt.
        const known = (
          await this.client.fetchRefunds(account, refund.razorpay_payment_id)
        ).find((r) => r.receipt === refund.id);
        remote =
          known ??
          (await this.client.createRefund(account, refund.razorpay_payment_id, {
            amountMinor: Number(refund.amount_minor),
            receipt: refund.id,
            reason: refund.reason ?? undefined,
          }));
      }
    } catch (error) {
      if (
        error instanceof RazorpayError &&
        error.kind === 'rejected' &&
        !refund.razorpay_refund_id
      ) {
        // Razorpay understood and refused: the refund will never happen, so the amount becomes refundable again.
        await this.db.withCheckout(tenantId, async (tx) => {
          await tx.execute(sql`
            update public.refunds set status = 'failed', failure_reason = ${error.message.slice(0, 500)}, updated_at = now()
            where id = ${refund.id}::uuid and tenant_id = ${tenantId}::uuid and status = 'pending'`);
          await recomputeRefundState(
            tx,
            tenantId,
            refund.payment_transaction_id,
          );
        });
        return this.read(tenantId, refund.id);
      }
      this.logger.warn({
        event: 'refund.call_failed',
        tenantId,
        refundId,
        kind: (error as RazorpayError).kind,
      });
      // Unknown outcome: the row stays as it is and is picked up again by a retry, a sync or the reconciliation job.
      throw new AppException(
        'UNAVAILABLE',
        'The refund is saved but Razorpay could not be reached. It will be retried; you can also sync it again shortly.',
        {
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          details: { refundId: refund.id },
        },
      );
    }
    if (remote.amountMinor !== Number(refund.amount_minor)) {
      this.logger.error({
        event: 'refund.amount_mismatch',
        tenantId,
        refundId,
      });
      throw new AppException(
        'CONFLICT',
        'Razorpay reports a different refund amount. Please contact support.',
        { code: 'REFUND_MISMATCH' },
      );
    }
    await this.db.withCheckout(tenantId, (tx) =>
      applyRefundState(tx, tenantId, refund.id, remote),
    );
    this.logger.log({
      event: 'refund.updated',
      tenantId,
      refundId,
      status: remote.status,
    });
    return this.read(tenantId, refund.id);
  }

  private async read(tenantId: string, refundId: string): Promise<RefundDto> {
    return this.db.withCheckout(tenantId, async (tx) => {
      const r = rowsOf<RefundRow & { order_number: number }>(
        await tx.execute(sql`
          select ${COLUMNS}, o.order_number from public.refunds r join public.orders o on o.id = r.order_id and o.tenant_id = r.tenant_id
          where r.id = ${refundId}::uuid and r.tenant_id = ${tenantId}::uuid`),
      )[0];
      if (!r) throw notFound('Refund not found.', 'REFUND_NOT_FOUND');
      return toDto(r, r.order_number);
    });
  }

  private async account(tx: DbTx, tenantId: string): Promise<RazorpayAccount> {
    let account: RazorpayAccount | null;
    try {
      account = await loadRazorpayAccount(tx, tenantId);
    } catch {
      throw new AppException('UNAVAILABLE', PAYMENTS_UNAVAILABLE_MESSAGE, {
        code: 'PAYMENTS_UNAVAILABLE',
      });
    }
    if (!account)
      throw conflict(
        'Razorpay is not set up for this store.',
        undefined,
        'RAZORPAY_NOT_CONFIGURED',
      );
    return account;
  }
}
