import { createHmac } from 'node:crypto';
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

import { as, createTestApp, type TestApp } from './support/app.js';
import { FakeRazorpay } from './support/fake-razorpay.js';
import {
  createTestDb,
  createUser,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)('self-service sign-up (e2e)', () => {
  let t: TestApp;
  let w: World;
  let fake: FakeRazorpay;
  let sup: Client;
  let n = 0;

  const sign = (order: string, payment: string) =>
    createHmac('sha256', ENV.RAZORPAY_PLATFORM_KEY_SECRET)
      .update(`${order}|${payment}`)
      .digest('hex');

  /** A payment at (fake) Razorpay for an order, in the given state. */
  const fakePayment = (orderId: string, over: Record<string, unknown> = {}) => {
    const order = fake.orders.get(orderId)!;
    const id = `pay_SIGN${String(++n).padStart(6, '0')}`;
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

  const webhook = (event: Record<string, unknown>, id?: string) => {
    const raw = JSON.stringify(event);
    const signature = createHmac('sha256', ENV.RAZORPAY_PLATFORM_WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');
    let req = request(t.app.getHttpServer())
      .post('/api/v1/webhooks/billing/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Forwarded-For', `10.8.${Math.floor(++n / 250)}.${n % 250}`)
      .set('X-Razorpay-Signature', signature);
    if (id) req = req.set('X-Razorpay-Event-Id', id);
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
  const failedEvent = (orderId: string, paymentId: string, amount: number) => ({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency: 'INR',
          status: 'failed',
          method: 'card',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Your card was declined',
        },
      },
    },
  });

  /** A registered person with no organization, like a customer who has just created an account. */
  let seq = 0;
  const newCustomer = async (name = 'New Customer') => {
    const id = await createUser(t.db, `customer${++seq}@example.test`, name);
    return { id, client: await as(t, id) };
  };
  const count = async (query: string, params: unknown[] = []) =>
    t.db.asOwner(async (pg) =>
      Number((await pg.query<{ n: string }>(query, params)).rows[0]?.n ?? 0),
    );

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
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
    await sup
      .post('/platform/plans', {
        code: 'starter',
        name: 'Starter',
        monthlyPrice: '999',
        yearlyPrice: '9990',
      })
      .expect(201);
    await sup
      .post('/platform/plans', {
        code: 'monthly-only',
        name: 'Monthly only',
        monthlyPrice: '499',
        yearlyPrice: '0',
      })
      .expect(201);
    await sup
      .post('/platform/plans', {
        code: 'free-tier',
        name: 'Free tier',
        monthlyPrice: '0',
        yearlyPrice: '0',
      })
      .expect(201);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
    await t?.db.close();
  });

  describe('who can use it', () => {
    it('needs a signed-in person', async () => {
      const anon = request(t.app.getHttpServer());
      await anon.get('/api/v1/signup/status').expect(401);
      await anon
        .post('/api/v1/signup/checkout')
        .send({ planCode: 'starter', billingInterval: 'monthly' })
        .expect(401);
      await anon
        .post('/api/v1/signup/store')
        .send({ storeName: 'No Session' })
        .expect(401);
    });

    it('starts with nothing in progress', async () => {
      const { client } = await newCustomer();
      const res = await client.get('/signup/status').expect(200);
      expect(res.body.data).toMatchObject({ state: 'none', signupId: null });
    });

    it('refuses platform staff, who can never own a store, before taking any money', async () => {
      const before = fake.orders.size;
      const res = await sup
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
        })
        .expect(403);
      expect(res.body.error.code).toBe('PLATFORM_ADMIN_CANNOT_BUY');
      expect(fake.orders.size).toBe(before);
    });
  });

  describe('choosing a plan', () => {
    it('refuses a plan that does not exist or an invalid billing period', async () => {
      const { client } = await newCustomer();
      const missing = await client
        .post('/signup/checkout', {
          planCode: 'nope-plan',
          billingInterval: 'monthly',
        })
        .expect(404);
      expect(missing.body.error.code).toBe('PLAN_NOT_FOUND');
      await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'weekly',
        })
        .expect(400);
    });

    it('does not give a paid plan away for a billing period that has no price', async () => {
      const { client } = await newCustomer();
      const res = await client
        .post('/signup/checkout', {
          planCode: 'monthly-only',
          billingInterval: 'yearly',
        })
        .expect(400);
      expect(res.body.error.code).toBe('INTERVAL_UNAVAILABLE');
      expect(
        (await client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('none');
      // The period that does have a price works.
      const ok = await client
        .post('/signup/checkout', {
          planCode: 'monthly-only',
          billingInterval: 'monthly',
        })
        .expect(200);
      expect(ok.body.data.totalMinor).toBe(49900);
    });

    it('never offers the unrestricted internal plan', async () => {
      const { client } = await newCustomer();
      const res = await client
        .post('/signup/checkout', {
          planCode: 'legacy',
          billingInterval: 'monthly',
        })
        .expect(404);
      expect(res.body.error.code).toBe('PLAN_NOT_FOUND');
    });
  });

  describe('paying', () => {
    it('creates one Razorpay order at the price the server works out, and reuses it on a retry', async () => {
      const { client } = await newCustomer();
      // The browser has no say in the price: a request that tries to name one is refused outright.
      await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
          amountMinor: 1,
        })
        .expect(400);
      const first = await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
        })
        .expect(200);
      expect(first.body.data).toMatchObject({
        state: 'payment_required',
        planCode: 'starter',
        totalMinor: 99900,
        currency: 'INR',
        payment: { keyId: ENV.RAZORPAY_PLATFORM_KEY_ID },
      });
      const orderId = first.body.data.payment.orderId as string;
      expect(fake.orders.get(orderId)?.amount).toBe(99900);
      expect(JSON.stringify(first.body)).not.toContain(
        ENV.RAZORPAY_PLATFORM_KEY_SECRET,
      );

      const orders = fake.orders.size;
      const again = await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
        })
        .expect(200);
      expect(again.body.data.payment.orderId).toBe(orderId);
      expect(fake.orders.size).toBe(orders);
    });

    it('does not trust the browser: a wrong signature is refused and nothing is paid', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      const res = await client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: 'f'.repeat(64),
        })
        .expect(400);
      expect(res.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
      const status = await client.get('/signup/status').expect(200);
      expect(status.body.data.state).toBe('payment_required');
    });

    it('does not count a payment Razorpay has not captured, even with a valid signature', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId, { status: 'failed' });
      const res = await client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sign(payment.orderId, paymentId),
        })
        .expect(409);
      expect(res.body.error.code).toBe('PAYMENT_NOT_CAPTURED');
      expect(
        (await client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('payment_required');
    });

    it('does not accept a payment that belongs to a different order', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const other = await newCustomer();
      const otherOrder = (
        await other.client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'yearly',
          })
          .expect(200)
      ).body.data.payment.orderId as string;
      const foreignPayment = fakePayment(otherOrder);
      // A valid signature for a payment of ANOTHER order, claimed against this one.
      const res = await client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: foreignPayment,
          razorpaySignature: sign(payment.orderId, foreignPayment),
        })
        .expect(400);
      expect(res.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    });

    it("keeps one person from confirming or reading another person's purchase", async () => {
      const owner = await newCustomer();
      const intruder = await newCustomer();
      const { payment } = (
        await owner.client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      const res = await intruder.client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sign(payment.orderId, paymentId),
        })
        .expect(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
      expect(
        (await intruder.client.get('/signup/status').expect(200)).body.data
          .state,
      ).toBe('none');
      expect(
        (await owner.client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('payment_required');
    });

    it('lets a failed payment be retried on the same order without a new account', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;

      await webhook(
        failedEvent(payment.orderId, 'pay_FAILED000001', 99900),
        `evt-fail-${payment.orderId}`,
      ).expect(200);
      const failed = await client.get('/signup/status').expect(200);
      expect(failed.body.data).toMatchObject({
        state: 'payment_required',
        lastFailure: 'Your card was declined',
      });

      // The same person asks again and gets the same order to pay.
      const retry = await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
        })
        .expect(200);
      expect(retry.body.data.payment.orderId).toBe(payment.orderId);

      const paymentId = fakePayment(payment.orderId);
      const ok = await client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sign(payment.orderId, paymentId),
        })
        .expect(200);
      expect(ok.body.data).toEqual({
        result: 'captured',
        state: 'store_required',
      });
    });

    it('treats the same payment confirmed twice as one payment', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      const body = {
        razorpayOrderId: payment.orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: sign(payment.orderId, paymentId),
      };
      expect(
        (await client.post('/signup/verify-payment', body).expect(200)).body
          .data.result,
      ).toBe('captured');
      expect(
        (await client.post('/signup/verify-payment', body).expect(200)).body
          .data.result,
      ).toBe('duplicate');
    });

    it('replaces an unpaid order when another plan is chosen, and flags a late payment of the old one for refund', async () => {
      const { client, id } = await newCustomer();
      const first = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const second = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'yearly',
          })
          .expect(200)
      ).body.data;
      expect(second.payment.orderId).not.toBe(first.payment.orderId);
      expect(second.totalMinor).toBe(999000);

      const latePayment = fakePayment(first.payment.orderId);
      await webhook(
        capturedEvent(first.payment.orderId, latePayment, 99900),
        `evt-late-${latePayment}`,
      ).expect(200);
      // Still waiting for the plan that was actually chosen, and the stray money is marked for a refund.
      expect(
        (await client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('payment_required');
      expect(
        await count(
          `select count(*) n from signup_orders where user_id = $1 and refund_required`,
          [id],
        ),
      ).toBe(1);
    });
  });

  describe('Razorpay webhook', () => {
    it('settles the purchase even if the browser never comes back, and a repeated event changes nothing', async () => {
      const { client, id } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      const event = capturedEvent(payment.orderId, paymentId, 99900);

      await webhook(event, `evt-${paymentId}`).expect(200);
      expect(
        (await client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('store_required');
      // A webhook only marks the purchase paid: it never creates a store by itself.
      expect(
        await count(`select count(*) n from memberships where user_id = $1`, [
          id,
        ]),
      ).toBe(0);

      const dup = await webhook(event, `evt-${paymentId}`).expect(200);
      expect(dup.body.data).toMatchObject({ duplicate: true });
      // A redelivery that arrives under a new event id is also harmless.
      await webhook(event, `evt-${paymentId}-again`).expect(200);
      expect(
        await count(
          `select count(*) n from signup_orders where user_id = $1 and status = 'paid'`,
          [id],
        ),
      ).toBe(1);
    });

    it('refuses an unsigned event', async () => {
      await request(t.app.getHttpServer())
        .post('/api/v1/webhooks/billing/razorpay')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(401);
    });

    it('does not mark a purchase paid when the amount is wrong', async () => {
      const { client } = await newCustomer();
      const { payment } = (
        await client
          .post('/signup/checkout', {
            planCode: 'starter',
            billingInterval: 'monthly',
          })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      // Refused (answered 500 like an invoice payment of the wrong amount, so the event stays visible as failed and is retried).
      await webhook(
        capturedEvent(payment.orderId, paymentId, 100),
        `evt-short-${paymentId}`,
      ).expect(500);
      expect(
        (await client.get('/signup/status').expect(200)).body.data.state,
      ).toBe('payment_required');
    });
  });

  describe('creating the store', () => {
    const pay = async (client: Client, planCode = 'starter') => {
      const { payment } = (
        await client
          .post('/signup/checkout', { planCode, billingInterval: 'monthly' })
          .expect(200)
      ).body.data;
      const paymentId = fakePayment(payment.orderId);
      await client
        .post('/signup/verify-payment', {
          razorpayOrderId: payment.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sign(payment.orderId, paymentId),
        })
        .expect(200);
      return { orderId: payment.orderId as string, paymentId };
    };

    it('is refused until the plan is paid', async () => {
      const { client, id } = await newCustomer();
      await client
        .post('/signup/checkout', {
          planCode: 'starter',
          billingInterval: 'monthly',
        })
        .expect(200);
      const res = await client
        .post('/signup/store', { storeName: 'Too Early' })
        .expect(409);
      expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
      expect(
        await count(`select count(*) n from memberships where user_id = $1`, [
          id,
        ]),
      ).toBe(0);

      const none = await newCustomer();
      const nothing = await none.client
        .post('/signup/store', { storeName: 'No Plan' })
        .expect(404);
      expect(nothing.body.error.code).toBe('SIGNUP_NOT_FOUND');
    });

    it('validates the store name', async () => {
      const { client } = await newCustomer();
      await pay(client);
      await client.post('/signup/store', { storeName: 'a' }).expect(400);
      await client.post('/signup/store', { storeName: '   ' }).expect(400);
      await client
        .post('/signup/store', { storeName: 'x'.repeat(81) })
        .expect(400);
      await client.post('/signup/store', {}).expect(400);
    });

    it('makes the person who paid the Owner of a new store on the plan they paid for, with a paid invoice', async () => {
      const { client, id } = await newCustomer('Asha Rao');
      const { orderId, paymentId } = await pay(client);

      const created = await client
        .post('/signup/store', { storeName: 'Blue Door Coffee' })
        .expect(200);
      expect(created.body.data).toMatchObject({
        created: true,
        storeSlug: 'blue-door-coffee',
      });
      const tenantId = created.body.data.tenantId as string;

      const orgs = await client.get('/organizations').expect(200);
      expect(orgs.body.data).toHaveLength(1);
      expect(orgs.body.data[0]).toMatchObject({ id: tenantId, role: 'owner' });
      const org = await as(t, id, tenantId);
      const current = await org.get('/organizations/current').expect(200);
      expect(current.body.data.store).toMatchObject({
        name: 'Blue Door Coffee',
      });

      const sub = (
        await sup
          .get(`/platform/organizations/${tenantId}/subscription`)
          .expect(200)
      ).body.data;
      expect(sub).toMatchObject({
        status: 'active',
        billingInterval: 'monthly',
      });
      expect(sub.plan.code).toBe('starter');
      expect(sub.trialEndsAt).toBeNull();

      // The owner can see the invoice for what they paid, already settled, with the payment attached.
      const invoices = await org.get('/billing/invoices').expect(200);
      expect(invoices.body.data).toHaveLength(1);
      expect(invoices.body.data[0]).toMatchObject({
        status: 'paid',
        planCode: 'starter',
        totalMinor: 99900,
      });
      expect(
        await count(
          `select count(*) n from billing_payments where tenant_id = $1 and status = 'succeeded' and razorpay_order_id = $2 and razorpay_payment_id = $3`,
          [tenantId, orderId, paymentId],
        ),
      ).toBe(1);

      const status = await client.get('/signup/status').expect(200);
      expect(status.body.data).toMatchObject({
        state: 'provisioned',
        tenantId,
      });
    });

    it('is idempotent: sending it twice, or at the same moment, creates one store', async () => {
      const { client, id } = await newCustomer();
      await pay(client);
      const [a, b] = await Promise.all([
        client.post('/signup/store', { storeName: 'Twice Over' }),
        client.post('/signup/store', { storeName: 'Twice Over' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.data.tenantId).toBe(b.body.data.tenantId);
      const again = await client
        .post('/signup/store', { storeName: 'Twice Over' })
        .expect(200);
      expect(again.body.data).toMatchObject({
        created: false,
        tenantId: a.body.data.tenantId,
      });
      expect(
        await count(`select count(*) n from memberships where user_id = $1`, [
          id,
        ]),
      ).toBe(1);
      expect(
        await count(
          `select count(*) n from billing_invoices where tenant_id = $1`,
          [a.body.data.tenantId],
        ),
      ).toBe(1);
    });

    it('does not create a second store when the payment webhook is delivered again afterwards', async () => {
      const { client, id } = await newCustomer();
      const { orderId, paymentId } = await pay(client);
      await client
        .post('/signup/store', { storeName: 'Webhook Shop' })
        .expect(200);
      const stores = await count(`select count(*) n from stores`);
      await webhook(
        capturedEvent(orderId, paymentId, 99900),
        `evt-after-${paymentId}`,
      ).expect(200);
      expect(await count(`select count(*) n from stores`)).toBe(stores);
      expect(
        await count(`select count(*) n from memberships where user_id = $1`, [
          id,
        ]),
      ).toBe(1);
    });

    it('gives two stores with the same name different addresses', async () => {
      const one = await newCustomer();
      const two = await newCustomer();
      await pay(one.client);
      await pay(two.client);
      const a = await one.client
        .post('/signup/store', { storeName: 'Same Name' })
        .expect(200);
      const b = await two.client
        .post('/signup/store', { storeName: 'Same Name' })
        .expect(200);
      expect(a.body.data.storeSlug).toBe('same-name');
      expect(b.body.data.storeSlug).not.toBe('same-name');
      expect(b.body.data.storeSlug).toMatch(/^same-name-[a-z0-9]{4}$/);
      expect(a.body.data.tenantId).not.toBe(b.body.data.tenantId);
    });

    it('copes with a name that is a reserved word or has no usable letters', async () => {
      const one = await newCustomer();
      const two = await newCustomer();
      await pay(one.client);
      await pay(two.client);
      const reserved = await one.client
        .post('/signup/store', { storeName: 'Admin' })
        .expect(200);
      expect(reserved.body.data.storeSlug).not.toBe('admin');
      const symbols = await two.client
        .post('/signup/store', { storeName: '!!! ???' })
        .expect(200);
      expect(symbols.body.data.storeSlug).toMatch(/^store-[a-z0-9]{4}$/);
    });

    it("keeps the new store's data away from every other organization", async () => {
      const { client, id } = await newCustomer();
      await pay(client);
      const created = await client
        .post('/signup/store', { storeName: 'Isolated Shop' })
        .expect(200);
      const mine = await as(t, id, created.body.data.tenantId);
      // The new owner works only in their own organization...
      await mine.get('/organizations/current').expect(200);
      // ...and cannot act in an organization they do not belong to, even by naming it.
      const foreign = await as(t, id, w.tenantA);
      const res = await foreign.get('/products');
      expect([403, 404]).toContain(res.status);
      // Nor does the new store show up for anyone else.
      const alice = await as(t, w.alice);
      const aliceOrgs = await alice.get('/organizations').expect(200);
      expect(
        (aliceOrgs.body.data as { id: string }[]).map((o) => o.id),
      ).not.toContain(created.body.data.tenantId);
    });
  });

  describe('free plans', () => {
    it('go straight to the store step with nothing to pay, and still become an active subscription', async () => {
      const { client, id } = await newCustomer();
      const orders = fake.orders.size;
      const res = await client
        .post('/signup/checkout', {
          planCode: 'free-tier',
          billingInterval: 'monthly',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        state: 'store_required',
        totalMinor: 0,
        payment: null,
      });
      expect(fake.orders.size).toBe(orders);

      const created = await client
        .post('/signup/store', { storeName: 'Free Shop' })
        .expect(200);
      const sub = (
        await sup
          .get(
            `/platform/organizations/${created.body.data.tenantId}/subscription`,
          )
          .expect(200)
      ).body.data;
      expect(sub).toMatchObject({ status: 'active' });
      expect(sub.plan.code).toBe('free-tier');
      expect(
        await count(
          `select count(*) n from billing_invoices where tenant_id = $1`,
          [created.body.data.tenantId],
        ),
      ).toBe(0);
      expect(
        await count(`select count(*) n from memberships where user_id = $1`, [
          id,
        ]),
      ).toBe(1);
    });
  });

  describe('Platform Admin tenant creation still works alongside it', () => {
    it('creates an organization with its own owner and the same kind of records', async () => {
      const res = await sup
        .post('/platform/organizations', {
          companyName: 'Admin Made Co',
          storeName: 'Admin Made',
          storeSlug: 'admin-made',
          ownerName: 'Owner',
          ownerEmail: 'admin-made@example.test',
          ownerPassword: 'Passw0rd-1',
        })
        .expect(201);
      const tenantId = res.body.data.tenantId as string;
      expect(
        await count(
          `select count(*) n from memberships where tenant_id = $1 and role = 'owner'`,
          [tenantId],
        ),
      ).toBe(1);
      expect(
        await count(
          `select count(*) n from stores where tenant_id = $1 and slug = 'admin-made'`,
          [tenantId],
        ),
      ).toBe(1);
      // Creating the same one again is still refused, not duplicated.
      await sup
        .post('/platform/organizations', {
          companyName: 'Admin Made Co',
          storeName: 'Admin Made',
          storeSlug: 'admin-made',
          ownerName: 'Owner',
          ownerEmail: 'admin-made-2@example.test',
          ownerPassword: 'Passw0rd-1',
        })
        .expect(409);
    });

    it('stays closed to a signed-in customer', async () => {
      const { client } = await newCustomer();
      await client
        .post('/platform/organizations', {
          companyName: 'Sneaky Co',
          storeName: 'Sneaky',
          storeSlug: 'sneaky',
          ownerName: 'Owner',
          ownerEmail: 'sneaky@example.test',
          ownerPassword: 'Passw0rd-1',
        })
        .expect(403);
      await client.get('/platform/organizations').expect(403);
    });
  });
});
