import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { rowsOf } from '../src/database/database.service.js';
import { CodCollectionService } from '../src/modules/checkout-payments/cod-collection.service.js';
import { RazorpayPaymentsService } from '../src/modules/checkout-payments/razorpay-payments.service.js';
import { NoAdjustments } from '../src/modules/orders/checkout-hooks.js';
import type { PlaceOrderDto } from '../src/modules/orders/checkout.dto.js';
import { CheckoutService } from '../src/modules/orders/checkout.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { CodService } from '../src/modules/payments/cod.service.js';
import { PaymentMethodsPolicy } from '../src/modules/payments/payment-methods.policy.js';
import { PaymentsEventLogger } from '../src/modules/payments/payments.logger.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { RazorpayClient } from '../src/modules/payments/razorpay.client.js';
import { RazorpayConnectionService } from '../src/modules/payments/razorpay-connection.service.js';
import { FakeRazorpay } from './support/fake-razorpay.js';
import {
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const KEY_ID = 'rzp_test_AbCdEfGh12345678';
const KEY_SECRET = 'Zk3Fq9Lm2Xv8Bn4Jt7Hs1Pw6';
const config = { get: () => ({ reservationMinutes: 30 }) } as never;
const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

const body = (
  slug: string,
  quantity: number,
  method: 'razorpay' | 'cod',
  email = 'asha@example.test',
): PlaceOrderDto => ({
  lines: [{ productSlug: slug, quantity }],
  customer: { fullName: 'Asha Rao', email, phone: '9876543210' },
  shippingAddress: address,
  paymentMethod: method,
});

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
  'Razorpay and COD payment flow (migration 0047)',
  () => {
    let t: TestDb;
    let w: World;
    let fake: FakeRazorpay;
    let paymentsSvc: PaymentsService;
    let connection: RazorpayConnectionService;
    let checkout: CheckoutService;
    let razorpay: RazorpayPaymentsService;
    let collection: CodCollectionService;
    let codSvc: CodService;
    let orders: OrdersService;
    let key = 0;
    const nextKey = () => `flow-key-${String(++key).padStart(6, '0')}`;
    const owner = () =>
      ({ userId: w.alice, tenantId: w.tenantA, role: 'owner' }) as never;
    const ownerB = () =>
      ({ userId: w.bob, tenantId: w.tenantB, role: 'owner' }) as never;

    const product = (
      tenant: string,
      slug: string,
      quantity: number,
      price = 50000,
    ) =>
      t.asOwner(async (pg) => {
        const r = await pg.query<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1, $2, $2, $3, $4, 'active') returning id`,
          [tenant, slug, price, quantity],
        );
        return r.rows[0].id;
      });
    const stock = (id: string) =>
      t.asOwner(async (pg) =>
        Number(
          (
            await pg.query<{ quantity: number }>(
              'select quantity from products where id = $1',
              [id],
            )
          ).rows[0].quantity,
        ),
      );
    const one = <T>(query: string, params: unknown[] = []) =>
      t.asOwner(
        async (pg) => (await pg.query<{ v: T }>(query, params)).rows[0]?.v,
      );
    const txOf = (tenant: string, orderNumber: number) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              `select p.* from payment_transactions p join orders o on o.id = p.order_id where o.tenant_id = $1 and o.order_number = $2`,
              [tenant, orderNumber],
            )
          ).rows[0],
      );
    const orderRow = (tenant: string, orderNumber: number) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              'select * from orders where tenant_id = $1 and order_number = $2',
              [tenant, orderNumber],
            )
          ).rows[0],
      );

    /** An online order placed and its Razorpay order created, ready to be paid. */
    async function startOnline(
      slug: string,
      quantity = 1,
      email = 'asha@example.test',
    ) {
      const placed = await checkout.placeOrder(
        'alpha-shop',
        body(slug, quantity, 'razorpay', email),
        nextKey(),
      );
      const session = await razorpay.createPayment(
        'alpha-shop',
        placed.orderNumber,
        placed.accessToken!,
      );
      return { placed, session, token: placed.accessToken! };
    }
    const verifyBody = (
      razorpayOrderId: string,
      paymentId: string,
      secret = KEY_SECRET,
    ) => ({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: fake.signature(razorpayOrderId, paymentId, secret),
    });

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      t = await createTestDb();
      w = await seedWorld(t);
      fake = new FakeRazorpay(KEY_ID, KEY_SECRET);
      const events = new PaymentsEventLogger({ log() {}, warn() {} });
      const client = new RazorpayClient(fake.fetch, undefined, {
        timeoutMs: 1000,
        retryDelayMs: 0,
      });
      paymentsSvc = new PaymentsService(t.service, events);
      connection = new RazorpayConnectionService(
        t.service,
        paymentsSvc,
        client,
        events,
      );
      checkout = new CheckoutService(
        t.service,
        config,
        new PaymentMethodsPolicy(),
        new NoAdjustments(),
      );
      razorpay = new RazorpayPaymentsService(t.service, checkout, client);
      collection = new CodCollectionService(t.service);
      codSvc = new CodService(t.service);
      orders = new OrdersService(t.service);
    });
    afterAll(() => t.close());

    describe('connecting Razorpay', () => {
      it('is off and unverified after the keys are saved, and takes no orders', async () => {
        await product(w.tenantA, 'gate-item', 5);
        const status = await paymentsSvc.save(owner(), {
          keyId: KEY_ID,
          keySecret: KEY_SECRET,
        });
        expect(status).toMatchObject({
          enabled: false,
          verificationStatus: 'unverified',
        });
        const err = await failure(
          checkout.placeOrder(
            'alpha-shop',
            body('gate-item', 1, 'razorpay'),
            nextKey(),
          ),
        );
        expect(err.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      });

      it('cannot be turned on before the keys are checked', async () => {
        expect((await failure(connection.setEnabled(owner(), true))).code).toBe(
          'RAZORPAY_NOT_VERIFIED',
        );
      });

      it('checks the keys against Razorpay (nothing is created there) and then allows turning it on', async () => {
        const before = fake.orders.size;
        const checked = await connection.verify(owner());
        expect(checked).toMatchObject({
          verificationStatus: 'verified',
          verificationError: null,
        });
        expect(fake.orders.size).toBe(before);
        expect(fake.calls.at(-1)).toEqual({
          method: 'GET',
          path: '/v1/orders?count=1',
        });
        expect(await connection.setEnabled(owner(), true)).toMatchObject({
          enabled: true,
        });
      });

      it('turns itself off and asks for a new check whenever the keys are replaced', async () => {
        const replaced = await paymentsSvc.save(owner(), {
          keyId: KEY_ID,
          keySecret: KEY_SECRET,
        });
        expect(replaced).toMatchObject({
          enabled: false,
          verificationStatus: 'unverified',
          verifiedAt: null,
        });
        await connection.verify(owner());
        await connection.setEnabled(owner(), true);
      });

      it('records a failed check, switches payments off and shows a safe reason', async () => {
        fake.keySecret = 'a-different-secret-than-saved';
        try {
          const failed = await connection.verify(owner());
          expect(failed).toMatchObject({
            verificationStatus: 'failed',
            enabled: false,
          });
          expect(failed.verificationError).toMatch(/did not accept/);
          expect(JSON.stringify(failed)).not.toContain(KEY_SECRET);
        } finally {
          fake.keySecret = KEY_SECRET;
        }
        await connection.verify(owner());
        await connection.setEnabled(owner(), true);
      });

      it('leaves the stored state alone when Razorpay cannot be reached', async () => {
        fake.failWith = 503;
        try {
          expect((await failure(connection.verify(owner()))).code).toBe(
            'PAYMENT_PROVIDER_UNAVAILABLE',
          );
        } finally {
          fake.failWith = null;
        }
        expect(await paymentsSvc.get(owner())).toMatchObject({
          verificationStatus: 'verified',
          enabled: true,
        });
      });

      it('cannot be switched by someone else’s organization', async () => {
        expect(
          (await failure(connection.setEnabled(ownerB(), true))).code,
        ).toBe('RAZORPAY_NOT_CONFIGURED');
        expect((await failure(connection.verify(ownerB()))).code).toBe(
          'RAZORPAY_NOT_CONFIGURED',
        );
      });
    });

    describe('paying online', () => {
      it('creates the Razorpay order for the server-computed amount and reuses it on a retry', async () => {
        await product(w.tenantA, 'online-a', 10, 50000);
        const before = fake.orders.size;
        const { placed, session } = await startOnline('online-a', 2);
        expect(fake.orders.size).toBe(before + 1);
        expect(session).toMatchObject({
          keyId: KEY_ID,
          amountMinor: 100000,
          currency: 'INR',
          orderNumber: placed.orderNumber,
        });
        expect(fake.orders.get(session.razorpayOrderId)).toMatchObject({
          amount: 100000,
          receipt: `SF-${placed.orderNumber}`,
        });
        expect(JSON.stringify(session)).not.toContain(KEY_SECRET);

        const again = await razorpay.createPayment(
          'alpha-shop',
          placed.orderNumber,
          placed.accessToken!,
        );
        expect(again.razorpayOrderId).toBe(session.razorpayOrderId);
        expect(fake.orders.size).toBe(before + 1);
        expect((await txOf(w.tenantA, placed.orderNumber)).attempts).toBe(2);
      });

      it('needs the order token to start a payment', async () => {
        await product(w.tenantA, 'online-token', 3);
        const placed = await checkout.placeOrder(
          'alpha-shop',
          body('online-token', 1, 'razorpay'),
          nextKey(),
        );
        expect(
          (
            await failure(
              razorpay.createPayment('alpha-shop', placed.orderNumber, 'nope'),
            )
          ).code,
        ).toBe('ORDER_NOT_FOUND');
      });

      it('confirms the order only after the signature and Razorpay both agree, then sells the stock', async () => {
        const id = await product(w.tenantA, 'online-pay', 5, 50000);
        const { placed, session, token } = await startOnline('online-pay', 2);
        expect(await stock(id)).toBe(5);
        const payment = fake.pay(session.razorpayOrderId, 'captured');

        const done = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, payment.id),
        );
        expect(done).toMatchObject({
          status: 'confirmed',
          paymentStatus: 'paid',
        });
        expect(await stock(id)).toBe(3);
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'captured',
          razorpay_payment_id: payment.id,
          method: 'upi',
          refund_required: false,
        });
        expect(
          await one(
            'select r.status as v from inventory_reservations r join orders o on o.id = r.order_id where o.order_number = $1 and o.tenant_id = $2',
            [placed.orderNumber, w.tenantA],
          ),
        ).toBe('committed');

        // Sending the same confirmation again changes nothing.
        const twice = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, payment.id),
        );
        expect(twice.status).toBe('confirmed');
        expect(await stock(id)).toBe(3);
      });

      it('rejects a wrong signature and changes nothing', async () => {
        const id = await product(w.tenantA, 'online-badsig', 5);
        const { placed, session, token } = await startOnline('online-badsig');
        const payment = fake.pay(session.razorpayOrderId, 'captured');
        const err = await failure(
          razorpay.verifyPayment(
            'alpha-shop',
            placed.orderNumber,
            token,
            verifyBody(
              session.razorpayOrderId,
              payment.id,
              'not-the-store-secret',
            ),
          ),
        );
        expect(err.code).toBe('PAYMENT_SIGNATURE_INVALID');
        expect(await orderRow(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'pending_payment',
          payment_status: 'unpaid',
        });
        expect(await stock(id)).toBe(5);
      });

      it('does not trust the browser: a valid signature is not enough if Razorpay reports another amount', async () => {
        const id = await product(w.tenantA, 'online-amount', 5, 50000);
        const { placed, session, token } = await startOnline('online-amount');
        const payment = fake.pay(session.razorpayOrderId, 'captured', {
          amount: 100,
        });
        const err = await failure(
          razorpay.verifyPayment(
            'alpha-shop',
            placed.orderNumber,
            token,
            verifyBody(session.razorpayOrderId, payment.id),
          ),
        );
        expect(err.code).toBe('PAYMENT_MISMATCH');
        expect(await orderRow(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'pending_payment',
          payment_status: 'unpaid',
        });
        expect(await stock(id)).toBe(5);
      });

      it('does not accept a payment that was made for a different Razorpay order', async () => {
        await product(w.tenantA, 'online-other-a', 5);
        await product(w.tenantA, 'online-other-b', 5);
        const a = await startOnline('online-other-a');
        const b = await startOnline('online-other-b', 1, 'b@example.test');
        const paymentForB = fake.pay(b.session.razorpayOrderId, 'captured');
        // The browser claims B's payment belongs to A's order.
        const err = await failure(
          razorpay.verifyPayment('alpha-shop', a.placed.orderNumber, a.token, {
            razorpay_order_id: a.session.razorpayOrderId,
            razorpay_payment_id: paymentForB.id,
            razorpay_signature: fake.signature(
              a.session.razorpayOrderId,
              paymentForB.id,
            ),
          }),
        );
        expect(err.code).toBe('PAYMENT_MISMATCH');
        expect(await orderRow(w.tenantA, a.placed.orderNumber)).toMatchObject({
          payment_status: 'unpaid',
        });
      });

      it('refuses payment details from a different order outright', async () => {
        await product(w.tenantA, 'online-mixed', 5);
        const a = await startOnline('online-mixed');
        const err = await failure(
          razorpay.verifyPayment(
            'alpha-shop',
            a.placed.orderNumber,
            a.token,
            verifyBody('order_SOMETHINGELSE1', 'pay_SOMETHINGELSE1'),
          ),
        );
        expect(err.code).toBe('PAYMENT_MISMATCH');
      });

      it('captures a payment Razorpay left only authorised, then confirms', async () => {
        await product(w.tenantA, 'online-auth', 5, 50000);
        const { placed, session, token } = await startOnline('online-auth');
        const payment = fake.pay(session.razorpayOrderId, 'authorized');
        const done = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, payment.id),
        );
        expect(done).toMatchObject({
          status: 'confirmed',
          paymentStatus: 'paid',
        });
        expect(
          fake.calls.some(
            (c) =>
              c.method === 'POST' &&
              c.path === `/v1/payments/${payment.id}/capture`,
          ),
        ).toBe(true);
        expect(fake.payments.get(payment.id)!.status).toBe('captured');
      });

      it('records a failed attempt from what Razorpay says, keeps the order open, and lets the shopper retry and pay', async () => {
        const id = await product(w.tenantA, 'online-retry', 5, 50000);
        const { placed, session, token } = await startOnline('online-retry');
        const failedPayment = fake.pay(session.razorpayOrderId, 'failed');
        const afterFail = await razorpay.reportFailure(
          'alpha-shop',
          placed.orderNumber,
          token,
          {
            razorpay_order_id: session.razorpayOrderId,
            razorpay_payment_id: failedPayment.id,
          },
        );
        expect(afterFail.status).toBe('pending_payment');
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'failed',
          failure_code: 'BAD_REQUEST_ERROR',
          failure_description: 'Payment failed at the bank',
        });
        // A failed payment never counts as paid, even if the browser also posts a (valid-looking) confirmation.
        const err = await failure(
          razorpay.verifyPayment(
            'alpha-shop',
            placed.orderNumber,
            token,
            verifyBody(session.razorpayOrderId, failedPayment.id),
          ),
        );
        expect(err.code).toBe('PAYMENT_FAILED');

        const retrySession = await razorpay.createPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
        );
        expect(retrySession.razorpayOrderId).toBe(session.razorpayOrderId);
        const good = fake.pay(session.razorpayOrderId, 'captured');
        const done = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, good.id),
        );
        expect(done).toMatchObject({
          status: 'confirmed',
          paymentStatus: 'paid',
        });
        expect(await stock(id)).toBe(4);
      });

      it('does not record a "failure" the browser invented for a payment that went through', async () => {
        await product(w.tenantA, 'online-liar', 5);
        const { placed, session, token } = await startOnline('online-liar');
        const real = fake.pay(session.razorpayOrderId, 'captured');
        const err = await failure(
          razorpay.reportFailure('alpha-shop', placed.orderNumber, token, {
            razorpay_order_id: session.razorpayOrderId,
            razorpay_payment_id: real.id,
          }),
        );
        expect(err.code).toBe('PAYMENT_NOT_FAILED');
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'created',
        });
      });

      it('will not apply one Razorpay payment to two orders', async () => {
        await product(w.tenantA, 'online-dup-a', 5);
        await product(w.tenantA, 'online-dup-b', 5);
        const a = await startOnline('online-dup-a');
        const b = await startOnline('online-dup-b', 1, 'dup@example.test');
        const payment = fake.pay(a.session.razorpayOrderId, 'captured');
        await razorpay.verifyPayment(
          'alpha-shop',
          a.placed.orderNumber,
          a.token,
          verifyBody(a.session.razorpayOrderId, payment.id),
        );
        // The same payment id is replayed against the other order: Razorpay says it belongs to order A.
        const err = await failure(
          razorpay.verifyPayment(
            'alpha-shop',
            b.placed.orderNumber,
            b.token,
            verifyBody(b.session.razorpayOrderId, payment.id),
          ),
        );
        expect(err.code).toBe('PAYMENT_MISMATCH');
        expect(await orderRow(w.tenantA, b.placed.orderNumber)).toMatchObject({
          payment_status: 'unpaid',
        });
        // And even if the answer matched, the database refuses a payment id used twice.
        await expect(
          t.asOwner((pg) =>
            pg.query(
              `update payment_transactions set razorpay_payment_id = $1 where order_id = (select id from orders where tenant_id = $2 and order_number = $3)`,
              [payment.id, w.tenantA, b.placed.orderNumber],
            ),
          ),
        ).rejects.toThrow();
      });

      it('cancelled order: the open payment attempt ends and the held stock returns', async () => {
        const id = await product(w.tenantA, 'online-cancel', 4);
        const { placed, token } = await startOnline('online-cancel', 2);
        const cancelled = await checkout.cancelOwnOrder(
          'alpha-shop',
          placed.orderNumber,
          token,
        );
        expect(cancelled.status).toBe('cancelled');
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'cancelled',
        });
        expect(await stock(id)).toBe(4);
        expect(
          (
            await failure(
              razorpay.createPayment('alpha-shop', placed.orderNumber, token),
            )
          ).code,
        ).toBe('ORDER_NOT_PAYABLE');
      });

      it('stops a payment once the time to pay has run out', async () => {
        const id = await product(w.tenantA, 'online-late', 4);
        const placed = await checkout.placeOrder(
          'alpha-shop',
          body('online-late', 1, 'razorpay'),
          nextKey(),
        );
        await t.asOwner((pg) =>
          pg.query(
            "update inventory_reservations set expires_at = now() - interval '1 minute' where product_id = $1",
            [id],
          ),
        );
        expect(
          (
            await failure(
              razorpay.createPayment(
                'alpha-shop',
                placed.orderNumber,
                placed.accessToken!,
              ),
            )
          ).code,
        ).toBe('ORDER_EXPIRED');
      });

      it('cancels a paid order whose items sold out meanwhile and flags the refund', async () => {
        const id = await product(w.tenantA, 'online-lost', 1, 50000);
        const { placed, session, token } = await startOnline('online-lost', 1);
        // The hold lapses, and someone else buys the only unit (cash on delivery, confirmed at once).
        await t.asOwner((pg) =>
          pg.query(
            "update inventory_reservations set expires_at = now() - interval '1 minute' where product_id = $1",
            [id],
          ),
        );
        await t.asOwner((pg) =>
          pg
            .query(
              'update tenant_cod_config set enabled = true where tenant_id = $1',
              [w.tenantA],
            )
            .catch(() => undefined),
        );
        await codSvc.save(owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 0,
        });
        await checkout.placeOrder(
          'alpha-shop',
          body('online-lost', 1, 'cod', 'rival@example.test'),
          nextKey(),
        );
        expect(await stock(id)).toBe(0);

        const payment = fake.pay(session.razorpayOrderId, 'captured');
        const result = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, payment.id),
        );
        expect(result).toMatchObject({
          status: 'cancelled',
          paymentStatus: 'paid',
        });
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'captured',
          refund_required: true,
        });
        expect(await stock(id)).toBe(0);
      });

      it('flags a refund when the money arrives for an order the cleanup job already cancelled', async () => {
        const id = await product(w.tenantA, 'online-closed', 3, 50000);
        const { placed, session, token } = await startOnline('online-closed');
        await t.asOwner((pg) =>
          pg.query(
            "update inventory_reservations set expires_at = now() - interval '1 minute' where product_id = $1",
            [id],
          ),
        );
        // The cleanup job closes the order.
        const { ReservationExpiryService } =
          await import('../src/modules/orders/reservation-expiry.service.js');
        await new ReservationExpiryService(t.service).expireDue();
        expect((await orderRow(w.tenantA, placed.orderNumber)).status).toBe(
          'cancelled',
        );

        const payment = fake.pay(session.razorpayOrderId, 'captured');
        const result = await razorpay.verifyPayment(
          'alpha-shop',
          placed.orderNumber,
          token,
          verifyBody(session.razorpayOrderId, payment.id),
        );
        expect(result).toMatchObject({
          status: 'cancelled',
          paymentStatus: 'paid',
        });
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          refund_required: true,
        });
      });

      it('reports Razorpay outages as a safe, retryable error', async () => {
        await product(w.tenantA, 'online-outage', 3);
        const placed = await checkout.placeOrder(
          'alpha-shop',
          body('online-outage', 1, 'razorpay'),
          nextKey(),
        );
        fake.failWith = 500;
        try {
          const err = await failure(
            razorpay.createPayment(
              'alpha-shop',
              placed.orderNumber,
              placed.accessToken!,
            ),
          );
          expect(err.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
          expect(err.message).not.toMatch(/rzp_|razorpay\.com/i);
        } finally {
          fake.failWith = null;
        }
        // Nothing half-written: the shopper can simply try again.
        expect(await txOf(w.tenantA, placed.orderNumber)).toBeUndefined();
        expect(
          (
            await razorpay.createPayment(
              'alpha-shop',
              placed.orderNumber,
              placed.accessToken!,
            )
          ).amountMinor,
        ).toBeGreaterThan(0);
      });

      it('a shopper who already paid can finish even if the Owner switched Razorpay off meanwhile', async () => {
        await product(w.tenantA, 'online-switchoff', 3);
        const { placed, session, token } =
          await startOnline('online-switchoff');
        const payment = fake.pay(session.razorpayOrderId, 'captured');
        await t.asOwner((pg) =>
          pg.query(
            'update tenant_razorpay_config set enabled = false where tenant_id = $1',
            [w.tenantA],
          ),
        );
        try {
          const done = await razorpay.verifyPayment(
            'alpha-shop',
            placed.orderNumber,
            token,
            verifyBody(session.razorpayOrderId, payment.id),
          );
          expect(done.paymentStatus).toBe('paid');
          // But nobody can START a payment while it is off.
          await product(w.tenantA, 'online-off-new', 3);
          expect(
            (
              await failure(
                checkout.placeOrder(
                  'alpha-shop',
                  body('online-off-new', 1, 'razorpay'),
                  nextKey(),
                ),
              )
            ).code,
          ).toBe('PAYMENT_METHOD_UNAVAILABLE');
        } finally {
          await connection.verify(owner());
          await connection.setEnabled(owner(), true);
        }
      });
    });

    describe('credentials stay inside their tenant', () => {
      it("the checkout role cannot read another organization's credentials, even by id", async () => {
        await paymentsSvc.save(ownerB(), {
          keyId: 'rzp_test_BobBobBob12345678',
          keySecret: 'Qw3Er4Ty5Ui6Op7As8Df9Gh0',
        });
        const leaked = await t.service.withCheckout(w.tenantA, async (tx) =>
          rowsOf(
            await tx.execute(
              sql`select * from public.get_razorpay_credentials(${w.tenantB}::uuid)`,
            ),
          ),
        );
        expect(leaked).toEqual([]);
      });

      it("another tenant's checkout does not take payments just because tenant A does", async () => {
        await product(w.tenantB, 'beta-online', 3);
        const err = await failure(
          checkout.placeOrder(
            'beta-shop',
            body('beta-online', 1, 'razorpay'),
            nextKey(),
          ),
        );
        expect(err.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      });

      it('a payment cannot be started or confirmed through another store using the order token', async () => {
        await product(w.tenantA, 'cross-store', 3);
        const { placed, token } = await startOnline('cross-store');
        expect(
          (
            await failure(
              razorpay.createPayment('beta-shop', placed.orderNumber, token),
            )
          ).code,
        ).toBe('ORDER_NOT_FOUND');
      });

      it('the credentials function is unreachable for signed-in users (and so for PostgREST)', async () => {
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`select * from public.get_razorpay_credentials(${w.tenantA}::uuid)`,
            ),
          ),
        ).rejects.toThrow();
      });

      it('the Owner cannot read the encrypted secret columns either', async () => {
        await expect(
          t.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql`select secret_ciphertext from public.tenant_razorpay_config`,
            ),
          ),
        ).rejects.toThrow();
      });
    });

    describe('cash on delivery', () => {
      it('is not offered until the Owner turns it on', async () => {
        await product(w.tenantB, 'beta-cod', 3);
        const err = await failure(
          checkout.placeOrder(
            'beta-shop',
            body('beta-cod', 1, 'cod'),
            nextKey(),
          ),
        );
        expect(err.code).toBe('COD_NOT_AVAILABLE');
      });

      it('applies the Owner’s limits and adds the COD charge to the total', async () => {
        await product(w.tenantA, 'cod-limits', 20, 50000);
        await codSvc.save(owner(), {
          enabled: true,
          minOrderMinor: 60000,
          maxOrderMinor: 200000,
          feeMinor: 4000,
        });
        expect(
          (
            await failure(
              checkout.placeOrder(
                'alpha-shop',
                body('cod-limits', 1, 'cod'),
                nextKey(),
              ),
            )
          ).code,
        ).toBe('COD_NOT_AVAILABLE'); // 500 < 600
        expect(
          (
            await failure(
              checkout.placeOrder(
                'alpha-shop',
                body('cod-limits', 5, 'cod'),
                nextKey(),
              ),
            )
          ).code,
        ).toBe('COD_NOT_AVAILABLE'); // 2500 > 2000
        const placed = await checkout.placeOrder(
          'alpha-shop',
          body('cod-limits', 2, 'cod'),
          nextKey(),
        );
        expect(placed).toMatchObject({
          subtotalMinor: 100000,
          codFeeMinor: 4000,
          totalMinor: 104000,
          status: 'confirmed',
          paymentStatus: 'pending_collection',
        });
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          provider: 'cod',
          status: 'pending_collection',
          amount_minor: 104000,
        });
        await codSvc.save(owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 0,
        });
      });

      it('rejects a maximum below the minimum', async () => {
        const err = await failure(
          codSvc.save(owner(), {
            enabled: true,
            minOrderMinor: 5000,
            maxOrderMinor: 100,
            feeMinor: 0,
          }),
        );
        expect(err.kind).toBe('VALIDATION');
      });

      it('keeps one organization’s COD settings away from another', async () => {
        expect((await codSvc.get(ownerB())).configured).toBe(false);
        expect((await codSvc.get(owner())).configured).toBe(true);
      });

      it('is never "paid" until the cash is collected, and collection needs the order to be with the carrier', async () => {
        await product(w.tenantA, 'cod-collect', 5, 50000);
        const placed = await checkout.placeOrder(
          'alpha-shop',
          body('cod-collect', 1, 'cod'),
          nextKey(),
        );
        const id = (await one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [w.tenantA, placed.orderNumber],
        ))!;
        expect(placed.paymentStatus).toBe('pending_collection');

        expect((await failure(collection.collect(owner(), id))).code).toBe(
          'COD_NOT_DELIVERED',
        );
        for (const status of [
          'processing',
          'ready_to_ship',
          'shipped',
        ] as const)
          await orders.updateStatus(owner(), id, { status });
        await collection.collect(owner(), id);
        await collection.collect(owner(), id); // repeating is harmless
        expect(await orderRow(w.tenantA, placed.orderNumber)).toMatchObject({
          payment_status: 'collected',
        });
        expect(await txOf(w.tenantA, placed.orderNumber)).toMatchObject({
          status: 'collected',
          collected_by: w.alice,
        });

        // Collected cash must be refunded, not just cancelled away.
        expect(
          (await failure(orders.cancel(owner(), id, { reason: 'x' }))).code,
        ).toBe('REFUND_REQUIRED');
      });

      it('cannot mark an online order or another organization’s order as collected', async () => {
        await product(w.tenantA, 'cod-wrong', 5);
        const { placed } = await startOnline('cod-wrong');
        const id = (await one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [w.tenantA, placed.orderNumber],
        ))!;
        expect((await failure(collection.collect(owner(), id))).code).toBe(
          'NOT_COD',
        );
        expect((await failure(collection.collect(ownerB(), id))).code).toBe(
          'ORDER_NOT_FOUND',
        );
      });
    });

    describe('which methods the checkout page may show', () => {
      it('reports Razorpay and COD availability from the Owner’s settings', async () => {
        const policy = new PaymentMethodsPolicy();
        const options = await t.service.withCheckout(w.tenantA, (tx) =>
          policy.options(tx, w.tenantA, 50000),
        );
        expect(options).toEqual({
          razorpay: { available: true },
          cod: { available: true, feeMinor: 0, reason: null },
        });
        const otherTenant = await t.service.withCheckout(w.tenantB, (tx) =>
          policy.options(tx, w.tenantB, 50000),
        );
        expect(otherTenant.razorpay.available).toBe(false);
      });
    });
  },
);
