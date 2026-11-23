import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import { NO_TENANT } from '../orders/checkout.service.js';
import {
  RazorpayClient,
  RazorpayError,
  type RazorpayPayment,
} from '../payments/razorpay.client.js';
import {
  loadRazorpayAccount,
  type RazorpayAccount,
} from '../payments/razorpay-credentials.js';
import { verifyWebhookSignature } from '../payments/razorpay-signature.js';
import {
  applyRefundState,
  refundStatusFrom,
} from '../payments/refund-accounting.js';
import { settleCapturedPayment } from './payment-settlement.js';

type Json = Record<string, unknown>;
type Outcome = { status: 'processed' | 'ignored'; note?: string };
export type WebhookResult = 'processed' | 'ignored' | 'duplicate';

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const entity = (payload: Json, key: string): Json | null => {
  const holder = payload[key] as Json | undefined;
  const e = holder?.entity as Json | undefined;
  return e && typeof e === 'object' ? e : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unauthorized = () =>
  new AppException('UNAUTHENTICATED', 'Invalid webhook.', {
    code: 'WEBHOOK_INVALID',
  });

/**
 * Razorpay webhooks. In order, and no step is skipped:
 *   1. The tenant comes from the URL; its OWN webhook secret checks the signature over the exact bytes received. Unknown
 *      tenant, no secret saved and a bad signature all answer the same 401, so nothing can be probed.
 *   2. The event is stored once per (tenant, Razorpay event id). A redelivery of a finished event does nothing and answers 200.
 *   3. Only then is it processed, and only with data that matches our own records (order, amount, currency).
 * An error while processing answers 500 so Razorpay delivers it again; a rejected or irrelevant event answers 200.
 */
@Injectable()
export class RazorpayWebhookService {
  private readonly logger = new Logger(RazorpayWebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly client: RazorpayClient,
  ) {}

  async handle(
    tenantPublicId: string,
    raw: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<{ result: WebhookResult }> {
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw unauthorized();

    const tenantId = await this.db.withCheckout(
      NO_TENANT,
      async (tx) =>
        rowsOf<{ id: string | null }>(
          await tx.execute(
            sql`select public.get_tenant_by_public_id(${tenantPublicId.toLowerCase()}) as id`,
          ),
        )[0]?.id ?? null,
    );
    if (!tenantId) throw unauthorized();

    let account: RazorpayAccount | null;
    try {
      account = await this.db.withCheckout(tenantId, (tx) =>
        loadRazorpayAccount(tx, tenantId),
      );
    } catch {
      this.logger.error({ event: 'webhook.credentials_unreadable', tenantId });
      throw new AppException(
        'UNAVAILABLE',
        'Webhooks are temporarily unavailable.',
        { code: 'PAYMENTS_UNAVAILABLE' },
      );
    }
    if (
      !account?.webhookSecret ||
      !verifyWebhookSignature(raw, signature, account.webhookSecret)
    ) {
      this.logger.warn({ event: 'webhook.signature_invalid', tenantId });
      throw unauthorized();
    }

    let body: Json;
    try {
      body = JSON.parse(raw.toString('utf8')) as Json;
    } catch {
      throw new AppException(
        'VALIDATION',
        'The webhook body is not valid JSON.',
        { code: 'WEBHOOK_BODY_INVALID' },
      );
    }
    const eventType = str(body.event);
    if (!eventType)
      throw new AppException('VALIDATION', 'The webhook has no event.', {
        code: 'WEBHOOK_BODY_INVALID',
      });
    const payload = (body.payload ?? {}) as Json;
    const payment = entity(payload, 'payment');
    const refund = entity(payload, 'refund');
    const order = entity(payload, 'order');
    // Razorpay sends a unique id per event; without it the body itself identifies a redelivery.
    const eventId = (
      str(eventIdHeader) ?? createHash('sha256').update(raw).digest('hex')
    ).slice(0, 200);

    const first = await this.db.withCheckout(tenantId, async (tx) => {
      const inserted = rowsOf<{ id: string }>(
        await tx.execute(sql`
          insert into public.payment_webhook_events (tenant_id, event_id, event_type, razorpay_order_id, razorpay_payment_id, razorpay_refund_id)
          values (${tenantId}::uuid, ${eventId}, ${eventType.slice(0, 100)},
            coalesce(${str(payment?.order_id) ?? str(order?.id)},
              -- a refund event names only the payment: link it to its Razorpay order for the transaction timeline
              (select t.razorpay_order_id from public.payment_transactions t
                where t.tenant_id = ${tenantId}::uuid and t.razorpay_payment_id = ${str(payment?.id) ?? str(refund?.payment_id)})),
            ${str(payment?.id) ?? str(refund?.payment_id)}, ${str(refund?.id)})
          on conflict (tenant_id, event_id) do nothing returning id`),
      )[0];
      if (inserted) return true;
      const existing = rowsOf<{ status: string }>(
        await tx.execute(sql`
          select status from public.payment_webhook_events where tenant_id = ${tenantId}::uuid and event_id = ${eventId} for update`),
      )[0];
      if (
        existing &&
        (existing.status === 'processed' || existing.status === 'ignored')
      )
        return false;
      // Received but never finished (a crash) or failed: this delivery gets to finish it.
      await tx.execute(sql`
        update public.payment_webhook_events set attempts = attempts + 1, status = 'received'
        where tenant_id = ${tenantId}::uuid and event_id = ${eventId}`);
      return true;
    });
    if (!first) return { result: 'duplicate' };

    let outcome: Outcome;
    try {
      outcome = await this.process(
        tenantId,
        account,
        eventType,
        payment,
        refund,
      );
    } catch (error) {
      await this.finish(
        tenantId,
        eventId,
        'failed',
        (error as Error).name?.slice(0, 100) ?? 'error',
      );
      this.logger.error({
        event: 'webhook.failed',
        tenantId,
        type: eventType,
        name: (error as Error).name,
      });
      throw error;
    }
    await this.finish(tenantId, eventId, outcome.status, outcome.note ?? null);
    this.logger.log({
      event: 'webhook.handled',
      tenantId,
      type: eventType,
      status: outcome.status,
    });
    return { result: outcome.status };
  }

  private async process(
    tenantId: string,
    account: RazorpayAccount,
    type: string,
    payment: Json | null,
    refund: Json | null,
  ): Promise<Outcome> {
    switch (type) {
      case 'payment.captured':
      case 'order.paid':
        return payment
          ? this.onCaptured(tenantId, payment)
          : { status: 'ignored', note: 'No payment in the event.' };
      case 'payment.authorized':
        return payment
          ? this.onAuthorized(tenantId, account, payment)
          : { status: 'ignored', note: 'No payment in the event.' };
      case 'payment.failed':
        return payment
          ? this.onFailed(tenantId, payment)
          : { status: 'ignored', note: 'No payment in the event.' };
      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed':
        return refund
          ? this.onRefund(tenantId, refund)
          : { status: 'ignored', note: 'No refund in the event.' };
      default:
        return { status: 'ignored', note: 'Event type not used.' };
    }
  }

  /** The transaction for a Razorpay order, with the amount we expect and whether its order can still be paid. */
  private async find(
    tx: DbTx,
    tenantId: string,
    razorpayOrderId: string | null,
  ) {
    if (!razorpayOrderId) return undefined;
    return rowsOf<{
      id: string;
      status: string;
      amount_minor: number;
      currency: string;
      order_status: string;
    }>(
      await tx.execute(sql`
        select t.id, t.status, t.amount_minor::float8 as amount_minor, t.currency, o.status as order_status
        from public.payment_transactions t join public.orders o on o.id = t.order_id and o.tenant_id = t.tenant_id
        where t.tenant_id = ${tenantId}::uuid and t.razorpay_order_id = ${razorpayOrderId}`),
    )[0];
  }

  private matches(
    row: { amount_minor: number; currency: string },
    payment: Json,
  ): boolean {
    return (
      Number(row.amount_minor) === payment.amount &&
      row.currency === (str(payment.currency) ?? 'INR')
    );
  }

  private async onCaptured(tenantId: string, p: Json): Promise<Outcome> {
    const paymentId = str(p.id);
    return this.db.withCheckout(tenantId, async (tx) => {
      const row = await this.find(tx, tenantId, str(p.order_id));
      if (!row || !paymentId)
        return { status: 'ignored', note: 'No matching payment transaction.' };
      if (!this.matches(row, p)) {
        this.logger.warn({ event: 'webhook.amount_mismatch', tenantId });
        return {
          status: 'ignored',
          note: 'Amount or currency does not match the order.',
        };
      }
      await settleCapturedPayment(tx, tenantId, row.id, {
        id: paymentId,
        method: str(p.method),
      });
      return { status: 'processed' };
    });
  }

  /** An authorised payment is captured here (we have its exact amount), then settled like any captured one. */
  private async onAuthorized(
    tenantId: string,
    account: RazorpayAccount,
    p: Json,
  ): Promise<Outcome> {
    const paymentId = str(p.id);
    const row = await this.db.withCheckout(tenantId, (tx) =>
      this.find(tx, tenantId, str(p.order_id)),
    );
    if (!row || !paymentId)
      return { status: 'ignored', note: 'No matching payment transaction.' };
    if (!this.matches(row, p))
      return {
        status: 'ignored',
        note: 'Amount or currency does not match the order.',
      };
    if (row.status === 'captured')
      return { status: 'processed', note: 'Already captured.' };
    if (row.order_status !== 'pending_payment')
      return {
        status: 'ignored',
        note: 'The order can no longer be paid; the authorisation lapses at Razorpay.',
      };

    let captured: RazorpayPayment;
    try {
      captured = await this.client.capturePayment(
        account,
        paymentId,
        Number(row.amount_minor),
        row.currency,
      );
    } catch (error) {
      if (!(error instanceof RazorpayError) || error.kind !== 'rejected')
        throw error;
      // Probably captured already (automatically, or by the shopper's confirmation): ask, rather than assume.
      captured = await this.client.fetchPayment(account, paymentId);
    }
    if (captured.status !== 'captured')
      return { status: 'ignored', note: 'Payment is not captured.' };
    return this.db.withCheckout(tenantId, async (tx) => {
      await settleCapturedPayment(tx, tenantId, row.id, {
        id: captured.id,
        method: captured.method,
      });
      return { status: 'processed' } as Outcome;
    });
  }

  private async onFailed(tenantId: string, p: Json): Promise<Outcome> {
    return this.db.withCheckout(tenantId, async (tx) => {
      const row = await this.find(tx, tenantId, str(p.order_id));
      if (!row)
        return { status: 'ignored', note: 'No matching payment transaction.' };
      // A failed attempt never overwrites a payment that already went through.
      await tx.execute(sql`
        update public.payment_transactions set status = 'failed', method = ${str(p.method)},
          failure_code = ${str(p.error_code)?.slice(0, 100) ?? null}, failure_description = ${str(p.error_description)?.slice(0, 500) ?? null},
          updated_at = now()
        where id = ${row.id}::uuid and tenant_id = ${tenantId}::uuid and status in ('created', 'failed')`);
      return { status: 'processed' } as Outcome;
    });
  }

  private async onRefund(tenantId: string, r: Json): Promise<Outcome> {
    const refundId = str(r.id);
    const paymentId = str(r.payment_id);
    const status = str(r.status) ?? 'pending';
    if (!refundId || !paymentId || typeof r.amount !== 'number')
      return { status: 'ignored', note: 'Incomplete refund.' };
    const receipt = str(r.receipt);
    return this.db.withCheckout(tenantId, async (tx) => {
      let ours = rowsOf<{ id: string; amount_minor: number }>(
        await tx.execute(sql`
          select id, amount_minor::float8 as amount_minor from public.refunds
          where tenant_id = ${tenantId}::uuid and (razorpay_refund_id = ${refundId}
            ${receipt && UUID.test(receipt) ? sql`or id = ${receipt}::uuid` : sql``})
          for update`),
      )[0];
      if (!ours) {
        // A refund made directly in the Razorpay dashboard: record it, because the money has left.
        const t = rowsOf<{
          id: string;
          order_id: string;
          currency: string;
          provider: string;
        }>(
          await tx.execute(sql`
            select id, order_id, currency, provider from public.payment_transactions
            where tenant_id = ${tenantId}::uuid and razorpay_payment_id = ${paymentId}`),
        )[0];
        if (!t)
          return {
            status: 'ignored',
            note: 'No matching payment transaction.',
          };
        ours = rowsOf<{ id: string; amount_minor: number }>(
          await tx.execute(sql`
            insert into public.refunds (tenant_id, order_id, payment_transaction_id, amount_minor, currency, status, source, idempotency_key, razorpay_refund_id, reason)
            values (${tenantId}::uuid, ${t.order_id}::uuid, ${t.id}::uuid, ${r.amount as number}, ${t.currency}, 'processing', 'razorpay_dashboard',
              ${`rzp-${refundId}`}, ${refundId}, 'Refunded in the Razorpay dashboard')
            on conflict (tenant_id, idempotency_key) do update set updated_at = now()
            returning id, amount_minor::float8 as amount_minor`),
        )[0];
      } else if (Number(ours.amount_minor) !== r.amount) {
        this.logger.warn({ event: 'webhook.refund_amount_mismatch', tenantId });
        return {
          status: 'ignored',
          note: 'Refund amount does not match our record.',
        };
      }
      await applyRefundState(tx, tenantId, ours.id, {
        id: refundId,
        status: refundStatusFrom(status),
      });
      return { status: 'processed' } as Outcome;
    });
  }

  private finish(
    tenantId: string,
    eventId: string,
    status: 'processed' | 'ignored' | 'failed',
    note: string | null,
  ) {
    return this.db.withCheckout(tenantId, (tx) =>
      tx.execute(sql`
        update public.payment_webhook_events set status = ${status}, note = ${note?.slice(0, 500) ?? null},
          processed_at = case when ${status} = 'failed' then null else now() end
        where tenant_id = ${tenantId}::uuid and event_id = ${eventId}`),
    );
  }
}
