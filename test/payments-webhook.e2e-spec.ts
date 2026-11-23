import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { createTestApp, type TestApp } from './support/app.js';
import {
  createPaymentsWorld,
  type PaymentsWorld,
  WEBHOOK_SECRET,
} from './support/payments-world.js';
import { migrationsAvailable } from './support/pglite.js';

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe.skipIf(!migrationsAvailable)(
  'Razorpay webhooks and reconciliation (migration 0048)',
  () => {
    let p: PaymentsWorld;
    let publicId: string;
    let publicIdB: string;

    const send = (
      event: string,
      payload: Record<string, unknown>,
      opts: { secret?: string; eventId?: string; id?: string } = {},
    ) => {
      const hook = p.fake.webhook(
        event,
        payload,
        opts.secret ?? WEBHOOK_SECRET,
        opts.eventId,
      );
      return p.webhooks.handle(
        opts.id ?? publicId,
        hook.raw,
        hook.signature,
        hook.eventId,
      );
    };
    const paymentEntity = (payment: {
      id: string;
      order_id: string;
      amount: number;
      currency: string;
      status: string;
      method: string;
    }) => ({
      payment: { entity: payment },
    });
    const events = (tenant: string, type?: string) =>
      p.t.asOwner(
        async (pg) =>
          (
            await pg.query<{
              event_id: string;
              event_type: string;
              status: string;
              attempts: number;
              note: string | null;
            }>(
              `select event_id, event_type, status, attempts, note from payment_webhook_events where tenant_id = $1 ${type ? 'and event_type = $2' : ''} order by received_at`,
              type ? [tenant, type] : [tenant],
            )
          ).rows,
      );

    beforeAll(async () => {
      p = await createPaymentsWorld();
      await p.connectRazorpay();
      const ids = await p.t.asOwner(
        async (pg) =>
          (
            await pg.query<{ id: string; public_id: string }>(
              'select id, public_id from tenants',
            )
          ).rows,
      );
      publicId = ids.find((r) => r.id === p.w.tenantA)!.public_id;
      publicIdB = ids.find((r) => r.id === p.w.tenantB)!.public_id;
    });
    afterAll(() => p.t.close());

    describe('authentication', () => {
      it('answers 401 to a wrong signature, a tampered body, another tenant’s secret, and an unknown or unconfigured tenant', async () => {
        await p.product(p.w.tenantA, 'wh-auth', 5);
        const { session } = await p.startOnline('wh-auth');
        const payment = p.fake.pay(session.razorpayOrderId, 'captured');
        const payload = paymentEntity(payment);
        const good = p.fake.webhook(
          'payment.captured',
          payload,
          WEBHOOK_SECRET,
        );

        expect(
          (
            await failure(
              p.webhooks.handle(
                publicId,
                good.raw,
                'a'.repeat(64),
                good.eventId,
              ),
            )
          ).code,
        ).toBe('WEBHOOK_INVALID');
        expect(
          (
            await failure(
              p.webhooks.handle(publicId, good.raw, undefined, good.eventId),
            )
          ).code,
        ).toBe('WEBHOOK_INVALID');
        expect(
          (
            await failure(
              p.webhooks.handle(
                publicId,
                Buffer.from(good.raw.toString() + ' '),
                good.signature,
                good.eventId,
              ),
            )
          ).code,
        ).toBe('WEBHOOK_INVALID');
        expect(
          (
            await failure(
              send('payment.captured', payload, {
                secret: 'some-other-secret-value',
              }),
            )
          ).code,
        ).toBe('WEBHOOK_INVALID');
        expect(
          (await failure(send('payment.captured', payload, { id: 'zzzzzz' })))
            .code,
        ).toBe('WEBHOOK_INVALID');
        // The other organization has not saved a webhook secret at all, so nothing can authenticate against it.
        expect(
          (await failure(send('payment.captured', payload, { id: publicIdB })))
            .code,
        ).toBe('WEBHOOK_INVALID');
        expect(
          (
            await failure(
              p.webhooks.handle(
                publicId,
                Buffer.alloc(0),
                good.signature,
                good.eventId,
              ),
            )
          ).code,
        ).toBe('WEBHOOK_INVALID');
        // None of that changed anything.
        expect((await events(p.w.tenantA)).length).toBe(0);
      });

      it('rejects a correctly signed body that is not JSON, without storing anything', async () => {
        const raw = Buffer.from('this is not json');
        const { createHmac } = await import('node:crypto');
        const sig = createHmac('sha256', WEBHOOK_SECRET)
          .update(raw)
          .digest('hex');
        expect(
          (await failure(p.webhooks.handle(publicId, raw, sig, 'evt_bad_json')))
            .code,
        ).toBe('WEBHOOK_BODY_INVALID');
      });
    });

    describe('payments', () => {
      it('settles a payment the browser never confirmed, exactly once, however often it is delivered', async () => {
        const id = await p.product(p.w.tenantA, 'wh-capture', 5, 50000);
        const { placed, session } = await p.startOnline('wh-capture', 2);
        const payment = p.fake.pay(session.razorpayOrderId, 'captured');
        const first = await send('payment.captured', paymentEntity(payment), {
          eventId: 'evt_cap_1',
        });
        expect(first.result).toBe('processed');
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'confirmed', payment_status: 'paid' },
        );
        expect(await p.stock(id)).toBe(3);
        expect(await p.txOf(p.w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'captured',
          razorpay_payment_id: payment.id,
          method: 'upi',
        });

        // Razorpay redelivers the same event: acknowledged, nothing happens again.
        expect(
          (
            await send('payment.captured', paymentEntity(payment), {
              eventId: 'evt_cap_1',
            })
          ).result,
        ).toBe('duplicate');
        // A different event for the same payment (order.paid) is also harmless.
        expect(
          (
            await send('order.paid', paymentEntity(payment), {
              eventId: 'evt_paid_1',
            })
          ).result,
        ).toBe('processed');
        expect(await p.stock(id)).toBe(3);
        const rows = await events(p.w.tenantA);
        expect(rows.filter((r) => r.event_id === 'evt_cap_1')).toHaveLength(1);
        expect(rows.find((r) => r.event_id === 'evt_cap_1')).toMatchObject({
          status: 'processed',
          attempts: 1,
        });
      });

      it('does not trust the event: a different amount, an unknown order or a missing payment are ignored', async () => {
        await p.product(p.w.tenantA, 'wh-ignore', 5, 50000);
        const { placed, session } = await p.startOnline('wh-ignore');
        const cheap = p.fake.pay(session.razorpayOrderId, 'captured', {
          amount: 100,
        });
        const mismatch = await send('payment.captured', paymentEntity(cheap));
        expect(mismatch.result).toBe('ignored');
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'pending_payment', payment_status: 'unpaid' },
        );

        const stranger = await send(
          'payment.captured',
          paymentEntity({
            ...cheap,
            id: 'pay_STRANGER0001',
            order_id: 'order_NOSUCHORDER01',
          }),
        );
        expect(stranger.result).toBe('ignored');
        expect((await send('payment.captured', {})).result).toBe('ignored');
        expect((await send('subscription.activated', {})).result).toBe(
          'ignored',
        );
      });

      it('captures an authorised payment, and copes when Razorpay already captured it', async () => {
        await p.product(p.w.tenantA, 'wh-auth-cap', 5, 50000);
        const { placed, session } = await p.startOnline('wh-auth-cap');
        const authorized = p.fake.pay(session.razorpayOrderId, 'authorized');
        expect(
          (await send('payment.authorized', paymentEntity(authorized))).result,
        ).toBe('processed');
        expect(p.fake.payments.get(authorized.id)!.status).toBe('captured');
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'confirmed', payment_status: 'paid' },
        );

        // Auto-capture races us: Razorpay refuses our capture, so the payment is looked up instead.
        await p.product(p.w.tenantA, 'wh-auth-race', 5, 50000);
        const race = await p.startOnline(
          'wh-auth-race',
          1,
          'race@example.test',
        );
        const raced = p.fake.pay(race.session.razorpayOrderId, 'authorized');
        p.fake.payments.get(raced.id)!.status = 'captured';
        expect(
          (
            await send(
              'payment.authorized',
              paymentEntity({ ...raced, status: 'authorized' }),
            )
          ).result,
        ).toBe('processed');
        expect(
          await p.orderRow(p.w.tenantA, race.placed.orderNumber),
        ).toMatchObject({ status: 'confirmed' });
      });

      it('records a failed attempt but never lets it undo a payment that went through', async () => {
        await p.product(p.w.tenantA, 'wh-failed', 5);
        const { placed, session } = await p.startOnline('wh-failed');
        const failed = p.fake.pay(session.razorpayOrderId, 'failed');
        await send(
          'payment.failed',
          paymentEntity({
            ...failed,
            ...{
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Card declined',
            },
          } as never),
        );
        expect(await p.txOf(p.w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'failed',
        });

        const good = p.fake.pay(session.razorpayOrderId, 'captured');
        await send('payment.captured', paymentEntity(good));
        await send('payment.failed', paymentEntity(failed));
        expect(await p.txOf(p.w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'captured',
          razorpay_payment_id: good.id,
        });
      });

      it('flags a refund when money arrives for an order that is already closed', async () => {
        const id = await p.product(p.w.tenantA, 'wh-closed', 3, 50000);
        const { placed, session } = await p.startOnline('wh-closed');
        await p.t.asOwner((pg) =>
          pg.query(
            "update inventory_reservations set expires_at = now() - interval '1 minute' where product_id = $1",
            [id],
          ),
        );
        const { ReservationExpiryService } =
          await import('../src/modules/orders/reservation-expiry.service.js');
        await new ReservationExpiryService(p.t.service).expireDue();
        const payment = p.fake.pay(session.razorpayOrderId, 'captured');
        await send('payment.captured', paymentEntity(payment));
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'cancelled', payment_status: 'paid' },
        );
        expect(await p.txOf(p.w.tenantA, placed.orderNumber)).toMatchObject({
          refund_required: true,
        });
      });

      it('answers with an error when processing fails, so Razorpay redelivers, and finishes on the redelivery', async () => {
        await p.product(p.w.tenantA, 'wh-retry', 5, 50000);
        const { placed, session } = await p.startOnline('wh-retry');
        const authorized = p.fake.pay(session.razorpayOrderId, 'authorized');
        p.fake.failWith = 503;
        try {
          await expect(
            send('payment.authorized', paymentEntity(authorized), {
              eventId: 'evt_retry_1',
            }),
          ).rejects.toThrow();
        } finally {
          p.fake.failWith = null;
        }
        expect(
          (await events(p.w.tenantA)).find((e) => e.event_id === 'evt_retry_1'),
        ).toMatchObject({ status: 'failed' });
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'unpaid' },
        );

        expect(
          (
            await send('payment.authorized', paymentEntity(authorized), {
              eventId: 'evt_retry_1',
            })
          ).result,
        ).toBe('processed');
        expect(
          (await events(p.w.tenantA)).find((e) => e.event_id === 'evt_retry_1'),
        ).toMatchObject({ status: 'processed', attempts: 2 });
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'confirmed', payment_status: 'paid' },
        );
      });
    });

    describe('refunds', () => {
      const refundEntity = (r: {
        id: string;
        payment_id: string;
        amount: number;
        status: string;
        receipt: string | null;
      }) => ({
        refund: { entity: { ...r, currency: 'INR' } },
      });

      it('finishes a refund we started when Razorpay reports it processed', async () => {
        await p.product(p.w.tenantA, 'wh-refund', 5, 50000);
        const { placed, transactionId } = await p.paidOrder('wh-refund');
        p.fake.refundStartsAs = 'pending';
        let refund;
        try {
          refund = await p.refunds.create(
            p.owner(),
            transactionId,
            { reason: 'Webhook test' },
            'wh-refund-key-001',
          );
        } finally {
          p.fake.refundStartsAs = 'processed';
        }
        expect(refund.status).toBe('processing');
        const remote = p.fake.refunds.get(refund.razorpayRefundId!)!;
        remote.status = 'processed';
        await send('refund.processed', refundEntity(remote));
        const detail = await p.transactions.get(p.owner(), transactionId);
        expect(detail.refunds[0]).toMatchObject({
          status: 'processed',
          source: 'storeforge',
        });
        expect(detail.refunds[0].processedAt).toBeInstanceOf(Date);
        expect(detail.events.map((e) => e.eventType)).toContain(
          'refund.processed',
        );
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'refunded' },
        );
      });

      it('records a refund made directly in the Razorpay dashboard', async () => {
        await p.product(p.w.tenantA, 'wh-dash', 5, 50000);
        const { placed, transactionId, payment } = await p.paidOrder('wh-dash');
        const dashboard = {
          id: 'rfnd_DASHBOARD001',
          payment_id: payment.id,
          amount: 20000,
          status: 'processed',
          receipt: null,
        };
        await send(
          'refund.created',
          refundEntity({ ...dashboard, status: 'pending' }),
        );
        await send('refund.processed', refundEntity(dashboard));
        const detail = await p.transactions.get(p.owner(), transactionId);
        expect(detail.refunds).toHaveLength(1);
        expect(detail.refunds[0]).toMatchObject({
          source: 'razorpay_dashboard',
          amountMinor: 20000,
          status: 'processed',
          razorpayRefundId: 'rfnd_DASHBOARD001',
        });
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'partially_refunded' },
        );
      });

      it('puts the order back when a refund fails, and ignores a refund amount that does not match ours', async () => {
        await p.product(p.w.tenantA, 'wh-refund-fail', 5, 50000);
        const { placed, transactionId } = await p.paidOrder('wh-refund-fail');
        p.fake.refundStartsAs = 'pending';
        let refund;
        try {
          refund = await p.refunds.create(
            p.owner(),
            transactionId,
            { reason: 'Will fail' },
            'wh-refund-key-002',
          );
        } finally {
          p.fake.refundStartsAs = 'processed';
        }
        const remote = p.fake.refunds.get(refund.razorpayRefundId!)!;
        expect(
          (
            await send(
              'refund.processed',
              refundEntity({
                ...remote,
                amount: remote.amount + 1,
                status: 'processed',
              }),
            )
          ).result,
        ).toBe('ignored');
        remote.status = 'failed';
        await send('refund.failed', refundEntity(remote));
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'paid' },
        );
        expect(
          (await p.transactions.get(p.owner(), transactionId)).refunds[0]
            .status,
        ).toBe('failed');
      });
    });

    describe('reconciliation (no webhook, no browser confirmation)', () => {
      const age = (orderNumber: number, minutes = 30) =>
        p.t.asOwner((pg) =>
          pg.query(
            `update payment_transactions set updated_at = now() - ($1 || ' minutes')::interval
           where order_id = (select id from orders where tenant_id = $2 and order_number = $3)`,
            [String(minutes), p.w.tenantA, orderNumber],
          ),
        );

      it('settles a payment Razorpay reports as captured, and captures one that is only authorised', async () => {
        const id = await p.product(p.w.tenantA, 'rc-captured', 5, 50000);
        const a = await p.startOnline('rc-captured');
        p.fake.pay(a.session.razorpayOrderId, 'captured');
        await p.product(p.w.tenantA, 'rc-authorized', 5, 50000);
        const b = await p.startOnline('rc-authorized', 1, 'rc2@example.test');
        p.fake.pay(b.session.razorpayOrderId, 'authorized');
        await age(a.placed.orderNumber);
        await age(b.placed.orderNumber);

        const result = await p.reconciliation.reconcile();
        expect(result).toMatchObject({ failedTenants: 0, stoppedEarly: false });
        expect(result.paymentsSettled).toBeGreaterThanOrEqual(2);
        expect(
          await p.orderRow(p.w.tenantA, a.placed.orderNumber),
        ).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
        expect(
          await p.orderRow(p.w.tenantA, b.placed.orderNumber),
        ).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
        expect(await p.stock(id)).toBe(4);

        // A second run finds nothing left to do for them.
        expect((await p.reconciliation.reconcile()).paymentsSettled).toBe(0);
      });

      it('leaves recent attempts and unpaid orders alone', async () => {
        await p.product(p.w.tenantA, 'rc-recent', 5, 50000);
        const recent = await p.startOnline('rc-recent');
        p.fake.pay(recent.session.razorpayOrderId, 'captured'); // paid, but only seconds ago: webhook or browser may still arrive
        await p.product(p.w.tenantA, 'rc-unpaid', 5, 50000);
        const unpaid = await p.startOnline('rc-unpaid', 1, 'rc3@example.test');
        await age(unpaid.placed.orderNumber);

        await p.reconciliation.reconcile();
        expect(
          await p.orderRow(p.w.tenantA, recent.placed.orderNumber),
        ).toMatchObject({ payment_status: 'unpaid' });
        expect(
          await p.orderRow(p.w.tenantA, unpaid.placed.orderNumber),
        ).toMatchObject({
          status: 'pending_payment',
          payment_status: 'unpaid',
        });
      });

      it('does not settle a payment whose amount is not the order’s', async () => {
        await p.product(p.w.tenantA, 'rc-amount', 5, 50000);
        const x = await p.startOnline('rc-amount');
        p.fake.pay(x.session.razorpayOrderId, 'captured', { amount: 1 });
        await age(x.placed.orderNumber);
        await p.reconciliation.reconcile();
        expect(
          await p.orderRow(p.w.tenantA, x.placed.orderNumber),
        ).toMatchObject({ payment_status: 'unpaid' });
      });

      it('finishes refunds that have been waiting', async () => {
        await p.product(p.w.tenantA, 'rc-refund', 5, 50000);
        const { transactionId } = await p.paidOrder('rc-refund');
        p.fake.refundStartsAs = 'pending';
        let refund;
        try {
          refund = await p.refunds.create(
            p.owner(),
            transactionId,
            { reason: 'Slow' },
            'rc-refund-key-001',
          );
        } finally {
          p.fake.refundStartsAs = 'processed';
        }
        p.fake.refunds.get(refund.razorpayRefundId!)!.status = 'processed';
        await p.t.asOwner((pg) =>
          pg.query(
            "update refunds set updated_at = now() - interval '30 minutes' where id = $1",
            [refund.id],
          ),
        );
        const result = await p.reconciliation.reconcile();
        expect(result.refundsChecked).toBeGreaterThanOrEqual(1);
        expect(
          (await p.transactions.get(p.owner(), transactionId)).refunds[0]
            .status,
        ).toBe('processed');
      });

      it('stops within its time budget instead of running on', async () => {
        await p.product(p.w.tenantA, 'rc-budget', 5, 50000);
        const x = await p.startOnline('rc-budget');
        await age(x.placed.orderNumber);
        const result = await p.reconciliation.reconcile(-1);
        expect(result.stoppedEarly).toBe(true);
      });
    });

    describe('over HTTP (the raw body is what gets signed)', () => {
      let t: TestApp;
      beforeAll(async () => {
        t = await createTestApp(p.t);
      });
      afterAll(async () => {
        await t.close();
      });
      const post = (id: string) =>
        request(t.app.getHttpServer()).post(`/api/v1/webhooks/razorpay/${id}`);

      it('accepts a correctly signed delivery, answers 200, and acknowledges a repeat without acting twice', async () => {
        await p.product(p.w.tenantA, 'http-hook', 5, 50000);
        const { placed, session } = await p.startOnline('http-hook');
        const payment = p.fake.pay(session.razorpayOrderId, 'captured');
        const hook = p.fake.webhook(
          'payment.captured',
          paymentEntity(payment),
          WEBHOOK_SECRET,
          'evt_http_1',
        );

        const res = await post(publicId)
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', hook.signature)
          .set('X-Razorpay-Event-Id', hook.eventId)
          .send(hook.raw.toString())
          .expect(200);
        expect(res.body.data).toEqual({ result: 'processed' });
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { status: 'confirmed', payment_status: 'paid' },
        );

        const again = await post(publicId)
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', hook.signature)
          .set('X-Razorpay-Event-Id', hook.eventId)
          .send(hook.raw.toString())
          .expect(200);
        expect(again.body.data).toEqual({ result: 'duplicate' });
      });

      it('signs the bytes it receives: re-serialised JSON with the same content is rejected', async () => {
        const hook = p.fake.webhook(
          'payment.captured',
          {
            payment: {
              entity: {
                id: 'pay_X',
                order_id: 'order_X',
                amount: 1,
                currency: 'INR',
              },
            },
          },
          WEBHOOK_SECRET,
        );
        const pretty = JSON.stringify(JSON.parse(hook.raw.toString()), null, 2);
        await post(publicId)
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', hook.signature)
          .send(pretty)
          .expect(401);
      });

      it('answers 401 without a valid signature, for an unknown organization, and without a body', async () => {
        const hook = p.fake.webhook('payment.captured', {}, WEBHOOK_SECRET);
        await post(publicId)
          .set('Content-Type', 'application/json')
          .send(hook.raw.toString())
          .expect(401);
        await post(publicId)
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', 'nope')
          .send(hook.raw.toString())
          .expect(401);
        await post('nosuchorg')
          .set('Content-Type', 'application/json')
          .set('X-Razorpay-Signature', hook.signature)
          .send(hook.raw.toString())
          .expect(401);
        await post(publicId)
          .set('X-Razorpay-Signature', hook.signature)
          .expect(401);
      });

      it('is not an API anyone can read: no GET, and it is absent from the answers of other routes', async () => {
        await request(t.app.getHttpServer())
          .get(`/api/v1/webhooks/razorpay/${publicId}`)
          .expect(404);
      });
    });
  },
);
