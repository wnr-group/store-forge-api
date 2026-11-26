import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { verifyWebhookSignature } from '../payments/razorpay-signature.js';
import { PlatformRazorpayService } from './platform-razorpay.service.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/**
 * Razorpay webhooks for StoreForge's own account. The signature is checked against the EXACT bytes received, with the platform webhook
 * secret, before anything is read from the body. Every event is stored once by its event id; a redelivery answers 200 and changes nothing.
 * Money-moving rules live in the billing SQL functions (idempotent, amount-checked); this service only decodes and dispatches. An error
 * while processing answers 500 so Razorpay delivers the event again.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly razorpay: PlatformRazorpayService,
  ) {}

  async handle(
    raw: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<{ received: true; duplicate?: true }> {
    const secret = this.razorpay.webhookSecret();
    if (
      !Buffer.isBuffer(raw) ||
      !verifyWebhookSignature(raw, signature, secret)
    )
      throw new AppException('UNAUTHENTICATED', 'Invalid signature.', {
        code: 'WEBHOOK_SIGNATURE_INVALID',
      });

    let body: Json;
    try {
      body = obj(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new AppException('VALIDATION', 'The event body is not valid.', {
        code: 'WEBHOOK_BODY_INVALID',
      });
    }
    const type = str(body.event) ?? 'unknown';
    const payload = obj(body.payload);
    const payment = obj(obj(payload.payment).entity);
    const order = obj(obj(payload.order).entity);
    const refund = obj(obj(payload.refund).entity);
    const orderId = str(payment.order_id) ?? str(order.id);
    const paymentId = str(payment.id) ?? str(refund.payment_id);
    const refundId = str(refund.id);
    // Razorpay sends a unique id per event; without it the body's hash is just as unique and stable across redeliveries.
    const eventId =
      eventIdHeader && eventIdHeader.length <= 200
        ? eventIdHeader
        : `sha256:${createHash('sha256').update(raw).digest('hex')}`;

    const logged = await this.db.withPublic(
      async (tx) =>
        rowsOf<{ r: string }>(
          await tx.execute(
            sql`select public.billing_log_webhook(${eventId}, ${type}, ${orderId}, ${paymentId}, ${refundId}) as r`,
          ),
        )[0].r,
    );
    if (logged === 'duplicate') return { received: true, duplicate: true };

    try {
      const note = await this.db.withPublic(async (tx) =>
        this.dispatch(tx, type, { payment, order, refund }),
      );
      await this.finish(
        eventId,
        note === 'ignored' ? 'ignored' : 'processed',
        note,
      );
      return { received: true };
    } catch (error) {
      this.logger.error(
        `billing webhook ${type} failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await this.finish(eventId, 'failed', 'processing failed').catch(
        () => undefined,
      );
      throw error;
    }
  }

  private finish(eventId: string, status: string, note: string) {
    return this.db.withPublic(async (tx) => {
      await tx.execute(
        sql`select public.billing_finish_webhook(${eventId}, ${status}, ${note})`,
      );
    });
  }

  private async dispatch(
    tx: Parameters<Parameters<DatabaseService['withPublic']>[0]>[0],
    type: string,
    e: { payment: Json; order: Json; refund: Json },
  ): Promise<string> {
    if (
      type === 'payment.captured' ||
      type === 'order.paid' ||
      type === 'payment.authorized'
    ) {
      const p = e.payment;
      const orderId = str(p.order_id);
      const id = str(p.id);
      if (!orderId || !id) return 'ignored';
      let status = str(p.status);
      let amount = int(p.amount);
      let currency = str(p.currency) ?? '';
      if (type === 'payment.authorized' || status === 'authorized') {
        // Not captured yet: capture it, then record what Razorpay says happened.
        const fetched = await this.razorpay.fetchPayment(id);
        const captured =
          fetched.status === 'authorized'
            ? await this.razorpay.capturePayment(fetched)
            : fetched;
        status = captured.status;
        amount = captured.amountMinor;
        currency = captured.currency;
      }
      if (status !== 'captured') return 'ignored';
      const r = rowsOf<{ r: { result: string } }>(
        await tx.execute(sql`select public.billing_apply_payment(
          ${orderId}, ${id}, ${amount}::bigint, ${currency}, ${str(p.method)}, 'captured', null, null) as r`),
      )[0].r;
      if (r.result !== 'unknown_order') return r.result;
      // Not an invoice payment: it may be a customer buying a plan before their store exists (self-service sign-up).
      // This only marks the purchase paid; the store is created by the customer's own request, so a redelivered event cannot create one.
      const s = rowsOf<{ r: { result: string } }>(
        await tx.execute(sql`select public.signup_apply_payment(
          ${orderId}, ${id}, ${amount}::bigint, ${currency}, ${str(p.method)}, 'captured', null, null) as r`),
      )[0].r;
      return s.result === 'unknown_order' ? 'ignored' : `signup:${s.result}`;
    }
    if (type === 'payment.failed') {
      const p = e.payment;
      const orderId = str(p.order_id);
      const id = str(p.id);
      if (!orderId || !id) return 'ignored';
      const r = rowsOf<{ r: { result: string } }>(
        await tx.execute(sql`select public.billing_apply_payment(
          ${orderId}, ${id}, ${int(p.amount)}::bigint, ${str(p.currency) ?? ''}, ${str(p.method)}, 'failed',
          ${str(p.error_code)}, ${str(p.error_description)}) as r`),
      )[0].r;
      if (r.result !== 'unknown_order') return r.result;
      const s = rowsOf<{ r: { result: string } }>(
        await tx.execute(sql`select public.signup_apply_payment(
          ${orderId}, ${id}, ${int(p.amount)}::bigint, ${str(p.currency) ?? ''}, ${str(p.method)}, 'failed',
          ${str(p.error_code)}, ${str(p.error_description)}) as r`),
      )[0].r;
      return s.result === 'unknown_order' ? 'ignored' : `signup:${s.result}`;
    }
    if (
      type === 'refund.created' ||
      type === 'refund.processed' ||
      type === 'refund.failed'
    ) {
      const r = e.refund;
      const refundId = str(r.id);
      const paymentId = str(r.payment_id);
      if (!refundId || !paymentId) return 'ignored';
      const status = str(r.status);
      const mapped =
        status === 'processed'
          ? 'processed'
          : status === 'failed'
            ? 'failed'
            : 'pending';
      const out = rowsOf<{ r: { result: string } }>(
        await tx.execute(sql`select public.billing_apply_refund_event(
          ${paymentId}, ${refundId}, ${int(r.amount)}::bigint, ${mapped}, ${str(r.receipt)}) as r`),
      )[0].r;
      return out.result === 'unknown_payment' ? 'ignored' : out.result;
    }
    return 'ignored';
  }
}
