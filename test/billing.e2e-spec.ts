import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Read when the application module is loaded, so they must be set before anything is imported.
const ENV = vi.hoisted(() => {
  const env = {
    RAZORPAY_PLATFORM_KEY_ID: 'rzp_test_PlatformKey01',
    RAZORPAY_PLATFORM_KEY_SECRET: 'platform-secret-0123456789',
    RAZORPAY_PLATFORM_WEBHOOK_SECRET: 'platform-webhook-0123456789',
    CRON_SECRET: 'cron-secret-0123456789-0123456789-0123',
  };
  Object.assign(process.env, env);
  return env;
});

import { rowsOf } from '../src/database/database.service.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { FakeRazorpay } from './support/fake-razorpay.js';
import {
  asUser,
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

const YEAR = new Date().getUTCFullYear();

describe.skipIf(!migrationsAvailable)('subscription billing (e2e)', () => {
  let t: TestApp;
  let w: World;
  let fake: FakeRazorpay;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let alice: Client;
  let bob: Client;
  let writer: Client;
  let paidId: string;
  let invoiceA: { id: string; number: string; totalMinor: number };
  let paymentA: string;
  let n = 0;

  const sign = (
    order: string,
    payment: string,
    secret = ENV.RAZORPAY_PLATFORM_KEY_SECRET,
  ) => createHmac('sha256', secret).update(`${order}|${payment}`).digest('hex');

  const fakePayment = (orderId: string, over: Record<string, unknown> = {}) => {
    const order = fake.orders.get(orderId)!;
    const id = `pay_TEST${String(++n).padStart(6, '0')}`;
    fake.payments.set(id, {
      id,
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: 'captured',
      method: 'upi',
      ...over,
    } as never);
    return id;
  };

  const webhook = (
    event: Record<string, unknown>,
    opts: { id?: string; secret?: string; signature?: string | null } = {},
  ) => {
    const raw = JSON.stringify(event);
    const signature =
      opts.signature === undefined
        ? createHmac(
            'sha256',
            opts.secret ?? ENV.RAZORPAY_PLATFORM_WEBHOOK_SECRET,
          )
            .update(raw)
            .digest('hex')
        : opts.signature;
    let req = request(t.app.getHttpServer())
      .post('/api/v1/webhooks/billing/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', `10.9.${Math.floor(++n / 250)}.${n % 250}`);
    if (signature) req = req.set('X-Razorpay-Signature', signature);
    if (opts.id) req = req.set('X-Razorpay-Event-Id', opts.id);
    return req.send(raw);
  };
  const capturedEvent = (
    orderId: string,
    paymentId: string,
    amount: number,
  ) => ({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency: 'INR',
          status: 'captured',
          method: 'card',
        },
      },
    },
  });

  const audit = async (query: string) =>
    (await sup.get(`/platform/audit-logs?${query}`).expect(200)).body.data as {
      action: string;
      previousData: Record<string, unknown> | null;
      newData: Record<string, unknown> | null;
    }[];
  const subscription = async (tenant: string) =>
    (
      await sup
        .get(`/platform/organizations/${tenant}/subscription`)
        .expect(200)
    ).body.data;
  const invoice = async (id: string) =>
    (await sup.get(`/platform/billing/invoices/${id}`).expect(200)).body.data;
  const issue = (tenant: string, period: 'current' | 'next', c: Client = sup) =>
    c.post(`/platform/organizations/${tenant}/billing/invoices`, { period });
  const moveTo = (tenant: string, planId: string, interval = 'monthly') =>
    sup
      .put(`/platform/organizations/${tenant}/subscription`, {
        planId,
        billingInterval: interval,
      })
      .expect(200);
  const newOrg = async (slug: string, planId?: string) => {
    const res = await sup
      .post('/platform/organizations', {
        companyName: `${slug} Co`,
        storeName: slug,
        storeSlug: slug,
        ownerName: 'Owner',
        ownerEmail: `${slug}@example.test`,
        ownerPassword: 'Passw0rd-1',
        ...(planId ? { planId } : {}),
      })
      .expect(201);
    return {
      tenantId: res.body.data.tenantId as string,
      ownerId: res.body.data.ownerId as string,
    };
  };

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    const billingId = await createPlatformAdmin(
      db,
      'billing@example.test',
      'billing_admin',
    );
    const supportId = await createPlatformAdmin(
      db,
      'support@example.test',
      'support_admin',
    );
    fake = new FakeRazorpay(
      ENV.RAZORPAY_PLATFORM_KEY_ID,
      ENV.RAZORPAY_PLATFORM_KEY_SECRET,
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(((
      input: unknown,
      init?: unknown,
    ) =>
      String(input).includes('api.razorpay.com')
        ? fake.fetch(input as never, init as never)
        : Promise.reject(
            new TypeError('no network in tests'),
          )) as typeof fetch);
    t = await createTestApp(db);
    sup = await as(t, w.superAdmin);
    admin = await as(t, w.admin);
    billing = await as(t, billingId);
    support = await as(t, supportId);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
    writer = await as(t, w.members.writer);

    paidId = (
      await admin
        .post('/platform/plans', {
          code: 'paid',
          name: 'Paid',
          monthlyPrice: '999',
          yearlyPrice: '9990',
        })
        .expect(201)
    ).body.data.id;
    await moveTo(w.tenantA, paidId);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
    await t?.db.close();
  });

  describe('settings', () => {
    it('shows whether online payment is configured, and never the keys', async () => {
      const res = await billing.get('/platform/billing/settings').expect(200);
      expect(res.body.data).toMatchObject({
        paymentsConfigured: true,
        taxRateBps: 0,
        legalName: 'StoreForge',
      });
      expect(JSON.stringify(res.body)).not.toContain(
        ENV.RAZORPAY_PLATFORM_KEY_SECRET,
      );
      expect(JSON.stringify(res.body)).not.toContain(
        ENV.RAZORPAY_PLATFORM_WEBHOOK_SECRET,
      );
    });

    it('lets a Billing Admin change what appears on invoices, validates it, and logs only the changes', async () => {
      const res = await billing
        .put('/platform/billing/settings', {
          legalName: 'StoreForge Technologies Pvt Ltd',
          address: '1 Example Road, Kolkata',
          gstin: '19abcde1234f1z5',
          taxRateBps: 1800,
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        gstin: '19ABCDE1234F1Z5',
        taxRateBps: 1800,
        taxLabel: 'GST',
      });
      await billing
        .put('/platform/billing/settings', { taxRateBps: 1800 })
        .expect(200);
      expect(await audit('action=billing.settings_updated')).toHaveLength(1);
      for (const bad of [
        { taxRateBps: 20000 },
        { taxRateBps: -1 },
        { gstin: 'short' },
        { legalName: 'x' },
        { dueDays: 200 },
      ])
        await billing.put('/platform/billing/settings', bad).expect(400);
    });

    it('lets the Platform Admin read but not change them, and keeps Support out', async () => {
      await admin.get('/platform/billing/settings').expect(200);
      await admin
        .put('/platform/billing/settings', { taxRateBps: 0 })
        .expect(403);
      await support.get('/platform/billing/settings').expect(403);
      await alice.get('/platform/billing/settings').expect(403);
    });
  });

  describe('issuing invoices', () => {
    it('bills the current period from the plan, with tax, a sequential number and the seller as it is now', async () => {
      const res = await billing
        .post(`/platform/organizations/${w.tenantA}/billing/invoices`, {
          period: 'current',
        })
        .expect(201);
      const i = res.body.data;
      invoiceA = { id: i.id, number: i.number, totalMinor: i.totalMinor };
      expect(i).toMatchObject({
        number: `SF-${YEAR}-000001`,
        status: 'open',
        planCode: 'paid',
        billingInterval: 'monthly',
        currency: 'INR',
        subtotalMinor: 99900,
        taxRateBps: 1800,
        taxMinor: 17982,
        totalMinor: 117882,
        overdue: false,
        tenantName: expect.any(String),
        seller: {
          legalName: 'StoreForge Technologies Pvt Ltd',
          gstin: '19ABCDE1234F1Z5',
        },
      });
      expect((await audit('action=invoice.issued'))[0].newData).toMatchObject({
        number: i.number,
      });
    });

    it('bills a period only once, and refuses a free plan, an unknown organization and the wrong roles', async () => {
      const again = await issue(w.tenantA, 'current').expect(409);
      expect(again.body.error.code).toBe('INVOICE_EXISTS');
      const free = await issue(w.tenantB, 'current').expect(400);
      expect(free.body.error.code).toBe('NOTHING_TO_BILL');
      await issue('00000000-0000-4000-8000-000000000009', 'current').expect(
        404,
      );
      await sup
        .post(`/platform/organizations/${w.tenantA}/billing/invoices`, {
          period: 'sometime',
        })
        .expect(400);
      await admin
        .post(`/platform/organizations/${w.tenantA}/billing/invoices`, {
          period: 'next',
        })
        .expect(403);
      await support
        .post(`/platform/organizations/${w.tenantA}/billing/invoices`, {
          period: 'next',
        })
        .expect(403);
      await alice
        .post(`/platform/organizations/${w.tenantA}/billing/invoices`, {
          period: 'next',
        })
        .expect(403);
    });

    it('lists and filters invoices for the roles that may read them', async () => {
      const list = (await admin.get('/platform/billing/invoices').expect(200))
        .body;
      expect(list.meta.total).toBe(1);
      expect(
        (await admin.get('/platform/billing/invoices?status=paid').expect(200))
          .body.data,
      ).toHaveLength(0);
      expect(
        (
          await admin
            .get(`/platform/billing/invoices?search=${invoiceA.number}`)
            .expect(200)
        ).body.data,
      ).toHaveLength(1);
      expect(
        (
          await admin
            .get(`/platform/billing/invoices?org=${w.tenantB}`)
            .expect(200)
        ).body.data,
      ).toHaveLength(0);
      await support.get('/platform/billing/invoices').expect(403);
    });
  });

  describe('what the Owner sees', () => {
    it('lists only its own organization invoices, and nobody else can read them', async () => {
      expect(
        (await alice.get('/billing/invoices').expect(200)).body.data.map(
          (i: { id: string }) => i.id,
        ),
      ).toEqual([invoiceA.id]);
      expect(
        (await bob.get('/billing/invoices').expect(200)).body.data,
      ).toHaveLength(0);
      await bob.get(`/billing/invoices/${invoiceA.id}`).expect(404);
      await bob.get(`/billing/invoices/${invoiceA.id}/download`).expect(404);
      await bob.post(`/billing/invoices/${invoiceA.id}/pay`).expect(404);
      // Team members, even with full module access, are not the Owner.
      await writer.get('/billing/invoices').expect(403);
      await writer.post(`/billing/invoices/${invoiceA.id}/pay`).expect(403);
      expect(
        (await alice.get('/billing/overview').expect(200)).body.data,
      ).toMatchObject({
        planName: 'Paid',
        openInvoices: 1,
        overdue: false,
      });
    });

    it('downloads the invoice as a PDF built from the stored record', async () => {
      const res = await alice
        .get(`/billing/invoices/${invoiceA.id}/download`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain(
        `${invoiceA.number}.pdf`,
      );
      const pdf = (res.body as Buffer).toString('latin1');
      expect(pdf.startsWith('%PDF-1.4')).toBe(true);
      expect(pdf).toContain(invoiceA.number);
      expect(pdf).toContain('INR 1,178.82');
      expect(pdf).toContain('UNPAID');
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    });
  });

  describe('paying online', () => {
    let orderId: string;

    it('creates one Razorpay order, reuses it, and exposes only the public key id', async () => {
      const res = await alice
        .post(`/billing/invoices/${invoiceA.id}/pay`)
        .expect(200);
      orderId = res.body.data.orderId;
      expect(res.body.data).toMatchObject({
        keyId: ENV.RAZORPAY_PLATFORM_KEY_ID,
        amountMinor: invoiceA.totalMinor,
        currency: 'INR',
        invoiceNumber: invoiceA.number,
      });
      expect(JSON.stringify(res.body)).not.toContain(
        ENV.RAZORPAY_PLATFORM_KEY_SECRET,
      );
      const again = await alice
        .post(`/billing/invoices/${invoiceA.id}/pay`)
        .expect(200);
      expect(again.body.data.orderId).toBe(orderId);
      expect(fake.orders.size).toBe(1);
      expect(fake.orders.get(orderId)).toMatchObject({
        amount: invoiceA.totalMinor,
        receipt: invoiceA.number,
      });
    });

    it('does not count a payment until the server has verified it', async () => {
      const verify = (body: Record<string, unknown>) =>
        alice.post('/billing/payments/verify', body);
      const paymentId = fakePayment(orderId);

      // A forged or wrong signature.
      const bad = await verify({
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sign(
          orderId,
          paymentId,
          'wrong-secret-wrong-secret',
        ),
      }).expect(400);
      expect(bad.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
      await verify({
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: 'nope',
      }).expect(400);
      // A valid signature for a payment that Razorpay says is not captured.
      const notDone = fakePayment(orderId, { status: 'failed' });
      const res = await verify({
        razorpayOrderId: orderId,
        razorpayPaymentId: notDone,
        razorpaySignature: sign(orderId, notDone),
      }).expect(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_CAPTURED');
      // A payment of another order.
      await bob.post(`/billing/invoices/${invoiceA.id}/pay`).expect(404);
      const unknown = await verify({
        razorpayOrderId: 'order_nope',
        razorpayPaymentId: paymentId,
        razorpaySignature: sign('order_nope', paymentId),
      });
      expect(unknown.status).toBe(404);
      // Another Owner cannot confirm it either.
      await bob
        .post('/billing/payments/verify', {
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sign(orderId, paymentId),
        })
        .expect(404);
      expect((await invoice(invoiceA.id)).status).toBe('open');
    });

    it('refuses a captured payment whose amount is not the invoice amount', async () => {
      const short = fakePayment(orderId, { amount: 100 });
      const res = await alice
        .post('/billing/payments/verify', {
          razorpayOrderId: orderId,
          razorpayPaymentId: short,
          razorpaySignature: sign(orderId, short),
        })
        .expect(409);
      expect(res.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
      expect((await invoice(invoiceA.id)).status).toBe('open');
    });

    it('settles the invoice on a verified payment, and confirming again changes nothing', async () => {
      const paymentId = fakePayment(orderId);
      const body = {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sign(orderId, paymentId),
      };
      const ok = await alice.post('/billing/payments/verify', body).expect(200);
      expect(ok.body.data).toEqual({
        result: 'captured',
        invoiceStatus: 'paid',
      });
      const again = await alice
        .post('/billing/payments/verify', body)
        .expect(200);
      expect(again.body.data).toEqual({
        result: 'duplicate',
        invoiceStatus: 'paid',
      });

      const inv = await invoice(invoiceA.id);
      expect(inv.status).toBe('paid');
      expect(inv.paidAt).toBeTruthy();
      expect(inv.payments).toHaveLength(1);
      expect(inv.payments[0]).toMatchObject({
        status: 'succeeded',
        provider: 'razorpay',
        razorpayPaymentId: paymentId,
        method: 'upi',
        refundRequired: false,
      });
      paymentA = inv.payments[0].id;
      expect((await subscription(w.tenantA)).status).toBe('active');

      // A paid invoice cannot be paid again or voided; the PDF now shows the payment.
      await alice.post(`/billing/invoices/${invoiceA.id}/pay`).expect(409);
      await sup
        .post(`/platform/billing/invoices/${invoiceA.id}/void`, {
          reason: 'too late',
        })
        .expect(409);
      const pdf = (
        await alice
          .get(`/billing/invoices/${invoiceA.id}/download`)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
      ).body.toString('latin1');
      expect(pdf).toContain('PAID');
      expect(pdf).toContain(paymentId);
    });
  });

  describe('Razorpay webhooks', () => {
    let nextInvoice: { id: string };
    let nextOrder: string;
    let renewedUntil: string;

    it('rejects a missing or wrong signature before reading the body', async () => {
      const event = capturedEvent('order_x', 'pay_x', 100);
      expect((await webhook(event, { signature: null })).status).toBe(401);
      expect((await webhook(event, { signature: 'f'.repeat(64) })).status).toBe(
        401,
      );
      expect(
        (await webhook(event, { secret: 'another-secret-another-secret' }))
          .status,
      ).toBe(401);
      expect(
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from billing_webhook_events'),
        ),
      ).toMatchObject({ rows: [{ n: 0 }] });
    });

    it('settles the next period from a signed event and extends the subscription once', async () => {
      const before = await subscription(w.tenantA);
      nextInvoice = (await issue(w.tenantA, 'next').expect(201)).body.data;
      nextOrder = (
        await alice.post(`/billing/invoices/${nextInvoice.id}/pay`).expect(200)
      ).body.data.orderId;
      const paymentId = fakePayment(nextOrder);
      const event = capturedEvent(
        nextOrder,
        paymentId,
        fake.orders.get(nextOrder)!.amount,
      );

      const first = await webhook(event, { id: 'evt_001' });
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ received: true });
      const inv = await invoice(nextInvoice.id);
      expect(inv.status).toBe('paid');
      const after = await subscription(w.tenantA);
      expect(new Date(after.currentPeriodEnd).getTime()).toBe(
        new Date(inv.periodEnd).getTime(),
      );
      expect(new Date(after.currentPeriodEnd).getTime()).toBeGreaterThan(
        new Date(before.currentPeriodEnd).getTime(),
      );
      renewedUntil = after.currentPeriodEnd;

      // The same event delivered again (same id, then same body without an id) changes nothing.
      const replay = await webhook(event, { id: 'evt_001' });
      expect(replay.body.data).toEqual({ received: true, duplicate: true });
      const noId = await webhook(event);
      expect(noId.status).toBe(200);
      expect((await webhook(event)).body.data).toEqual({
        received: true,
        duplicate: true,
      });
      expect((await subscription(w.tenantA)).currentPeriodEnd).toBe(
        renewedUntil,
      );
      const pays = (await invoice(nextInvoice.id)).payments;
      expect(pays).toHaveLength(1);
    });

    it('stores each event once and ignores events for unknown orders and unrelated events', async () => {
      const unknown = await webhook(
        capturedEvent('order_unknown', 'pay_unknown', 100),
        { id: 'evt_002' },
      );
      expect(unknown.status).toBe(200);
      expect(
        (
          await webhook(
            { event: 'subscription.charged', payload: {} },
            { id: 'evt_003' },
          )
        ).status,
      ).toBe(200);
      const rows = rowsOf<{ event_id: string; status: string }>(
        (
          await t.db.asOwner((pg) =>
            pg.query(
              "select event_id, status from billing_webhook_events where event_id in ('evt_001','evt_002','evt_003') order by event_id",
            ),
          )
        ).rows,
      );
      expect(rows).toEqual([
        { event_id: 'evt_001', status: 'processed' },
        { event_id: 'evt_002', status: 'ignored' },
        { event_id: 'evt_003', status: 'ignored' },
      ]);
    });

    it('records a failed attempt and still accepts a later successful one on the same order', async () => {
      const tenant = await newOrg('retry-shop', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      const owner = await as(t, tenant.ownerId);
      const order = (
        await owner.post(`/billing/invoices/${inv.id}/pay`).expect(200)
      ).body.data.orderId;
      const failed = await webhook(
        {
          event: 'payment.failed',
          payload: {
            payment: {
              entity: {
                id: 'pay_failed1',
                order_id: order,
                amount: inv.totalMinor,
                currency: 'INR',
                status: 'failed',
                method: 'card',
                error_code: 'BAD_REQUEST_ERROR',
                error_description: 'Card declined',
              },
            },
          },
        },
        { id: 'evt_fail' },
      );
      expect(failed.status).toBe(200);
      expect(
        (await billing.get('/platform/billing/summary').expect(200)).body.data
          .failedPayments,
      ).toBe(1);
      let detail = await invoice(inv.id);
      expect(detail.status).toBe('open');
      expect(detail.payments[0]).toMatchObject({
        status: 'failed',
        failureCode: 'BAD_REQUEST_ERROR',
        failureDescription: 'Card declined',
      });
      const okId = fakePayment(order);
      await webhook(capturedEvent(order, okId, inv.totalMinor), {
        id: 'evt_ok',
      }).expect(200);
      detail = await invoice(inv.id);
      expect(detail.status).toBe('paid');
      expect(detail.payments[0]).toMatchObject({
        status: 'succeeded',
        razorpayPaymentId: okId,
        failureCode: null,
      });
    });

    it('keeps money that arrives for a void invoice and flags it for refund', async () => {
      const tenant = await newOrg('late-shop', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      const owner = await as(t, tenant.ownerId);
      const order = (
        await owner.post(`/billing/invoices/${inv.id}/pay`).expect(200)
      ).body.data.orderId;
      await billing
        .post(`/platform/billing/invoices/${inv.id}/void`, {
          reason: 'Issued in error',
        })
        .expect(200);
      const paymentId = fakePayment(order);
      await webhook(capturedEvent(order, paymentId, inv.totalMinor), {
        id: 'evt_late',
      }).expect(200);
      const detail = await invoice(inv.id);
      expect(detail.status).toBe('void');
      expect(detail.payments[0]).toMatchObject({
        status: 'succeeded',
        refundRequired: true,
      });
      const needing = (
        await billing
          .get('/platform/billing/payments?refundRequired=true')
          .expect(200)
      ).body.data;
      expect(needing.map((p: { id: string }) => p.id)).toContain(
        detail.payments[0].id,
      );
      expect(
        (await billing.get('/platform/billing/summary').expect(200)).body.data
          .paymentsNeedingRefund,
      ).toBe(1);
      // A void invoice cannot be paid again.
      await owner.post(`/billing/invoices/${inv.id}/pay`).expect(409);
    });
  });

  describe('refunds', () => {
    it('refunds part of a payment through Razorpay, then the rest, and never more than was paid', async () => {
      const start = await billing
        .get(`/platform/billing/payments/${paymentA}`)
        .expect(200);
      expect(start.body.data.status).toBe('succeeded');
      const refund = (body: Record<string, unknown>, c: Client = billing) =>
        c.post(`/platform/billing/payments/${paymentA}/refund`, body);

      const part = await refund({
        requestId: 'req-refund-0001',
        reason: 'Goodwill',
        amount: '100.00',
      }).expect(200);
      expect(part.body.data).toMatchObject({
        status: 'partially_refunded',
        refundedMinor: 10000,
      });
      expect(part.body.data.refunds[0]).toMatchObject({
        amountMinor: 10000,
        status: 'processed',
        reason: 'Goodwill',
      });
      expect(fake.refunds.size).toBe(1);

      // The same request again is the same refund.
      const repeat = await refund({
        requestId: 'req-refund-0001',
        reason: 'Goodwill',
        amount: '100.00',
      }).expect(200);
      expect(repeat.body.data.refundedMinor).toBe(10000);
      expect(fake.refunds.size).toBe(1);

      await refund({
        requestId: 'req-refund-0002',
        reason: 'Too much',
        amount: '99999.00',
      }).expect(400);
      await refund({
        requestId: 'req-refund-0003',
        reason: 'Bad amount',
        amount: '10.555',
      }).expect(400);
      await refund({ requestId: 'x', reason: 'Short id' }).expect(400);
      await refund({ requestId: 'req-refund-0004', reason: 'No' }).expect(400);

      const rest = await refund({
        requestId: 'req-refund-0005',
        reason: 'Cancelled plan',
      }).expect(200);
      expect(rest.body.data).toMatchObject({
        status: 'refunded',
        refundedMinor: invoiceA.totalMinor,
      });
      await refund({ requestId: 'req-refund-0006', reason: 'Again' }).expect(
        409,
      );
      expect((await audit('action=payment.refunded')).length).toBe(2);
    });

    it('is not allowed to the Platform Admin, Support or the tenant', async () => {
      const body = { requestId: 'req-refund-9999', reason: 'No right' };
      await admin
        .post(`/platform/billing/payments/${paymentA}/refund`, body)
        .expect(403);
      await support
        .post(`/platform/billing/payments/${paymentA}/refund`, body)
        .expect(403);
      await alice
        .post(`/platform/billing/payments/${paymentA}/refund`, body)
        .expect(403);
    });

    it('never refunds twice when the answer from Razorpay is lost', async () => {
      const tenant = await newOrg('lost-shop', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      const owner = await as(t, tenant.ownerId);
      const order = (
        await owner.post(`/billing/invoices/${inv.id}/pay`).expect(200)
      ).body.data.orderId;
      const payment = fakePayment(order);
      await webhook(capturedEvent(order, payment, inv.totalMinor), {
        id: 'evt_lost',
      }).expect(200);
      const id = (await invoice(inv.id)).payments[0].id;
      const before = fake.refunds.size;

      fake.loseNextRefundResponse = true;
      const body = {
        requestId: 'req-lost-0001',
        reason: 'Network trouble',
        amount: '50.00',
      };
      const failed = await billing.post(
        `/platform/billing/payments/${id}/refund`,
        body,
      );
      expect(failed.status).toBe(503);
      expect(fake.refunds.size).toBe(before + 1); // it did happen at Razorpay
      const pending = (
        await billing.get(`/platform/billing/payments/${id}`).expect(200)
      ).body.data;
      expect(pending.refunds[0].status).toBe('pending');
      expect(pending.refundedMinor).toBe(0);

      const retry = await billing
        .post(`/platform/billing/payments/${id}/refund`, body)
        .expect(200);
      expect(fake.refunds.size).toBe(before + 1); // found by its receipt, not sent again
      expect(retry.body.data).toMatchObject({
        status: 'partially_refunded',
        refundedMinor: 5000,
      });
    });

    it('records a refund made in the Razorpay dashboard and applies a processed event once', async () => {
      const tenant = await newOrg('dash-shop', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      const owner = await as(t, tenant.ownerId);
      const order = (
        await owner.post(`/billing/invoices/${inv.id}/pay`).expect(200)
      ).body.data.orderId;
      const payment = fakePayment(order);
      await webhook(capturedEvent(order, payment, inv.totalMinor), {
        id: 'evt_dash_pay',
      }).expect(200);
      const event = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_dash1',
              payment_id: payment,
              amount: 2000,
              status: 'processed',
              receipt: null,
            },
          },
        },
      };
      await webhook(event, { id: 'evt_dash_refund' }).expect(200);
      await webhook(event, { id: 'evt_dash_refund' }).expect(200);
      const detail = (await invoice(inv.id)).payments[0];
      expect(detail).toMatchObject({
        status: 'partially_refunded',
        refundedMinor: 2000,
      });
      const refunds = (
        await billing.get(`/platform/billing/payments/${detail.id}`).expect(200)
      ).body.data.refunds;
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        razorpayRefundId: 'rfnd_dash1',
        status: 'processed',
      });
    });
  });

  describe('offline payments and voiding', () => {
    it('settles an invoice from an offline payment, and can refund it as a record', async () => {
      const tenant = await newOrg('offline-shop', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      await support
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'UTR 123456',
          method: 'Bank transfer',
        })
        .expect(403);
      await admin
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'UTR 123456',
          method: 'Bank transfer',
        })
        .expect(403);
      await billing
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'x',
          method: 'Bank transfer',
        })
        .expect(400);
      const res = await billing
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'UTR 123456',
          method: 'Bank transfer',
          note: 'Received 3 Nov',
        })
        .expect(201);
      expect(res.body.data.status).toBe('paid');
      expect(res.body.data.payments[0]).toMatchObject({
        provider: 'manual',
        status: 'succeeded',
        reference: 'UTR 123456',
        amountMinor: inv.totalMinor,
      });
      await billing
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'UTR 999999',
          method: 'Cheque',
        })
        .expect(409);

      const calls = fake.calls.length;
      const refunded = await billing
        .post(
          `/platform/billing/payments/${res.body.data.payments[0].id}/refund`,
          { requestId: 'req-manual-0001', reason: 'Plan cancelled' },
        )
        .expect(200);
      expect(refunded.body.data.status).toBe('refunded');
      expect(fake.calls.length).toBe(calls); // an offline payment never touches Razorpay
      expect(
        (await audit('action=payment.manual_recorded')).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('renewals, overdue and expiry', () => {
    it('issues renewal invoices once, and does nothing on a second run', async () => {
      const tenant = await newOrg('renew-shop', paidId);
      await t.db.asOwner((pg) =>
        pg.query(
          "update tenant_subscriptions set current_period_end = now() + interval '2 days' where tenant_id = $1",
          [tenant.tenantId],
        ),
      );
      const first = (await billing.post('/platform/billing/run').expect(200))
        .body.data;
      expect(first.invoicesIssued).toBeGreaterThanOrEqual(1);
      const invs = (
        await billing
          .get(`/platform/billing/invoices?org=${tenant.tenantId}`)
          .expect(200)
      ).body.data;
      expect(invs).toHaveLength(1);
      expect(invs[0]).toMatchObject({ status: 'open', overdue: false });
      const sub = await subscription(tenant.tenantId);
      expect(new Date(invs[0].periodStart).getTime()).toBe(
        new Date(sub.currentPeriodEnd).getTime(),
      );

      const second = (await billing.post('/platform/billing/run').expect(200))
        .body.data;
      expect(second).toEqual({
        invoicesIssued: 0,
        markedPastDue: 0,
        expired: 0,
      });
      await admin.post('/platform/billing/run').expect(403);
      await support.post('/platform/billing/run').expect(403);
    });

    it('marks an unpaid invoice overdue, the subscription past due (still entitled), and recovers when it is paid', async () => {
      await billing
        .put('/platform/billing/settings', { dueDays: 0, graceDays: 7 })
        .expect(200);
      const tenant = await newOrg('late-pay', paidId);
      const inv = (await issue(tenant.tenantId, 'current').expect(201)).body
        .data;
      const run = (await billing.post('/platform/billing/run').expect(200)).body
        .data;
      expect(run.markedPastDue).toBeGreaterThanOrEqual(1);
      expect((await subscription(tenant.tenantId)).status).toBe('past_due');
      const overdue = (
        await billing
          .get('/platform/billing/invoices?status=overdue')
          .expect(200)
      ).body.data;
      expect(overdue.map((i: { id: string }) => i.id)).toContain(inv.id);
      expect(
        (
          await billing
            .get(`/platform/organizations/${tenant.tenantId}/billing`)
            .expect(200)
        ).body.data,
      ).toMatchObject({
        overdue: true,
        subscriptionStatus: 'past_due',
        openInvoices: 1,
      });
      expect(
        (await billing.get('/platform/billing/summary').expect(200)).body.data
          .overdueInvoices,
      ).toBeGreaterThanOrEqual(1);
      // Past due still has access during the grace period.
      expect(
        (await (await as(t, tenant.ownerId)).get('/entitlements').expect(200))
          .body.data.entitled,
      ).toBe(true);

      await billing
        .post(`/platform/billing/invoices/${inv.id}/payments`, {
          reference: 'UTR 777',
          method: 'Bank transfer',
        })
        .expect(201);
      expect((await subscription(tenant.tenantId)).status).toBe('active');
    });

    it('expires a subscription that stays unpaid past the grace period, and then grants nothing', async () => {
      await billing
        .put('/platform/billing/settings', { dueDays: 0, graceDays: 0 })
        .expect(200);
      const tenant = await newOrg('expired-shop', paidId);
      await issue(tenant.tenantId, 'current').expect(201);
      const run = (await billing.post('/platform/billing/run').expect(200)).body
        .data;
      expect(run.expired).toBeGreaterThanOrEqual(1);
      expect((await subscription(tenant.tenantId)).status).toBe('expired');
      expect(
        (await (await as(t, tenant.ownerId)).get('/entitlements').expect(200))
          .body.data.entitled,
      ).toBe(false);
      await billing
        .put('/platform/billing/settings', { dueDays: 7, graceDays: 7 })
        .expect(200);
    });

    it('lets the scheduler run it with the cron secret and refuses everything else', async () => {
      const call = (auth?: string) => {
        let r = request(t.app.getHttpServer())
          .get('/api/v1/internal/jobs/billing')
          .set('X-Forwarded-For', '10.8.0.1');
        if (auth) r = r.set('Authorization', auth);
        return r;
      };
      expect((await call()).status).toBe(401);
      expect(
        (await call('Bearer wrong-secret-wrong-secret-wrong-1')).status,
      ).toBe(401);
      const ok = await call(`Bearer ${ENV.CRON_SECRET}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        invoicesIssued: expect.any(Number),
      });
    });
  });

  describe('reporting', () => {
    it('summarises real payment data, with recurring revenue from paid active subscriptions', async () => {
      const s = (await admin.get('/platform/billing/summary').expect(200)).body
        .data;
      expect(s.mrr).toEqual([
        { currency: 'INR', amountMinor: expect.any(Number) },
      ]);
      expect(s.mrr[0].amountMinor).toBeGreaterThanOrEqual(99900);
      expect(s.successfulPayments).toBeGreaterThanOrEqual(5);
      expect(s.collected[0].currency).toBe('INR');
      expect(s.failedPayments).toBe(0); // the one declined card was retried successfully
      expect(s.refunded[0].amountMinor).toBeGreaterThanOrEqual(
        invoiceA.totalMinor,
      );
      await support.get('/platform/billing/summary').expect(403);
    });

    it('lists payments with filters and shows one organization billing position', async () => {
      const failed = (
        await billing
          .get('/platform/billing/payments?status=failed')
          .expect(200)
      ).body.data;
      expect(failed).toHaveLength(0);
      const all = (await billing.get('/platform/billing/payments').expect(200))
        .body;
      expect(all.meta.total).toBeGreaterThanOrEqual(6);
      expect(
        (
          await billing
            .get(`/platform/billing/payments?search=${invoiceA.number}`)
            .expect(200)
        ).body.data.length,
      ).toBeGreaterThanOrEqual(1);
      const mine = (
        await billing
          .get(`/platform/organizations/${w.tenantA}/billing`)
          .expect(200)
      ).body.data;
      expect(mine).toMatchObject({ planName: 'Paid', overdue: false });
      expect(mine.recentInvoices.length).toBeGreaterThanOrEqual(2);
      await billing
        .get('/platform/billing/payments/00000000-0000-4000-8000-000000000009')
        .expect(404);
    });
  });

  describe('data protection', () => {
    it('keeps invoices immutable, and never deletable, even for the database owner', async () => {
      await expect(
        t.db.asOwner((pg) =>
          pg.query(
            'update billing_invoices set total_minor = 1 where id = $1',
            [invoiceA.id],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        t.db.asOwner((pg) =>
          pg.query('delete from billing_invoices where id = $1', [invoiceA.id]),
        ),
      ).rejects.toThrow();
      await expect(
        t.db.asOwner((pg) =>
          pg.query(
            "update billing_invoices set status = 'open' where id = $1",
            [invoiceA.id],
          ),
        ),
      ).rejects.toThrow();
    });

    it('lets a tenant read only its own billing rows and change nothing directly', async () => {
      const own = await asUser(
        t.db,
        w.alice,
        async (tx) =>
          rowsOf<{ n: number }>(
            await tx.execute(
              sql`select count(*)::int as n from public.billing_invoices where tenant_id = ${w.tenantA}::uuid`,
            ),
          )[0].n,
      );
      expect(own).toBeGreaterThan(0);
      const others = await asUser(
        t.db,
        w.bob,
        async (tx) =>
          rowsOf<{ n: number }>(
            await tx.execute(
              sql`select count(*)::int as n from public.billing_invoices where tenant_id = ${w.tenantA}::uuid`,
            ),
          )[0].n,
      );
      expect(others).toBe(0);
      const staff = await asUser(
        t.db,
        w.members.writer,
        async (tx) =>
          rowsOf<{ n: number }>(
            await tx.execute(
              sql`select count(*)::int as n from public.billing_invoices`,
            ),
          )[0].n,
      );
      expect(staff).toBe(0);
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`update public.billing_payments set status = 'succeeded'`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`insert into public.billing_settings (id) values (true)`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(sql`select public.billing_run_scheduled()`),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`select public.billing_log_webhook('x', 'x', null, null, null)`,
          ),
        ),
      ).rejects.toThrow();
    });

    it("does not let an Owner apply a payment to another organization's order", async () => {
      const orderB = rowsOf<{ o: string }>(
        (
          await t.db.asOwner((pg) =>
            pg.query(
              'select razorpay_order_id as o from billing_payments where razorpay_order_id is not null limit 1',
            ),
          )
        ).rows,
      )[0].o;
      await expect(
        asUser(t.db, w.carol, (tx) =>
          tx.execute(
            sql`select public.billing_apply_payment(${orderB}, 'pay_evil', 1::bigint, 'INR', 'upi', 'captured', null, null)`,
          ),
        ),
      ).rejects.toThrow();
    });

    it('stores no card data and no secret in any billing row', async () => {
      const dump = JSON.stringify(
        (
          await t.db.asOwner((pg) => pg.query('select * from billing_payments'))
        ).rows.concat(
          (
            await t.db.asOwner((pg) =>
              pg.query('select * from billing_webhook_events'),
            )
          ).rows,
        ),
      );
      expect(dump).not.toContain(ENV.RAZORPAY_PLATFORM_KEY_SECRET);
      expect(dump).not.toContain(ENV.RAZORPAY_PLATFORM_WEBHOOK_SECRET);
      expect(dump).not.toMatch(/card_number|cvv|"number":"\d{12,}/i);
    });
  });
});
