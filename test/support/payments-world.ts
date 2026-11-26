import { randomBytes } from 'node:crypto';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service.js';
import { CodCollectionService } from '../../src/modules/checkout-payments/cod-collection.service.js';
import { PaymentReconciliationService } from '../../src/modules/checkout-payments/payment-reconciliation.service.js';
import { RazorpayPaymentsService } from '../../src/modules/checkout-payments/razorpay-payments.service.js';
import { RazorpayWebhookService } from '../../src/modules/checkout-payments/razorpay-webhook.service.js';
import { NoAdjustments } from '../../src/modules/orders/checkout-hooks.js';
import type { PlaceOrderDto } from '../../src/modules/orders/checkout.dto.js';
import { CheckoutService } from '../../src/modules/orders/checkout.service.js';
import { OrdersService } from '../../src/modules/orders/orders.service.js';
import { CodService } from '../../src/modules/payments/cod.service.js';
import { PaymentMethodsPolicy } from '../../src/modules/payments/payment-methods.policy.js';
import { PaymentsEventLogger } from '../../src/modules/payments/payments.logger.js';
import { PaymentsService } from '../../src/modules/payments/payments.service.js';
import { RazorpayClient } from '../../src/modules/payments/razorpay.client.js';
import { RazorpayConnectionService } from '../../src/modules/payments/razorpay-connection.service.js';
import { RefundsService } from '../../src/modules/payments/refunds.service.js';
import { TransactionsService } from '../../src/modules/payments/transactions.service.js';
import { FakeRazorpay } from './fake-razorpay.js';
import { createTestDb, type TestDb } from './pglite.js';
import { seedWorld, type World } from './world.js';

export const KEY_ID = 'rzp_test_AbCdEfGh12345678';
export const KEY_SECRET = 'Zk3Fq9Lm2Xv8Bn4Jt7Hs1Pw6';
export const WEBHOOK_SECRET = 'whsec-world-test-value-1';

const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

export const orderBody = (
  slug: string,
  quantity: number,
  method: 'razorpay' | 'cod' = 'razorpay',
  email = 'asha@example.test',
): PlaceOrderDto => ({
  lines: [{ productSlug: slug, quantity }],
  customer: { fullName: 'Asha Rao', email, phone: '9876543210' },
  shippingAddress: address,
  paymentMethod: method,
});

/** Two organizations on a real migrated database with every payment service wired to a fake Razorpay. */
export async function createPaymentsWorld() {
  process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
    randomBytes(32).toString('base64');
  process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
  const t: TestDb = await createTestDb();
  const w: World = await seedWorld(t);
  const fake = new FakeRazorpay(KEY_ID, KEY_SECRET);
  const events = new PaymentsEventLogger({ log() {}, warn() {} });
  const client = new RazorpayClient(fake.fetch, undefined, {
    timeoutMs: 1000,
    retryDelayMs: 0,
  });
  const config = { get: () => ({ reservationMinutes: 30 }) } as never;

  const payments = new PaymentsService(t.service, events);
  const connection = new RazorpayConnectionService(
    t.service,
    payments,
    client,
    events,
    new EntitlementsService(t.service),
  );
  const checkout = new CheckoutService(
    t.service,
    config,
    new PaymentMethodsPolicy(),
    new NoAdjustments(),
  );
  const razorpay = new RazorpayPaymentsService(t.service, checkout, client);
  const refunds = new RefundsService(t.service, client);
  const world = {
    t,
    w,
    fake,
    client,
    payments,
    connection,
    checkout,
    razorpay,
    refunds,
    transactions: new TransactionsService(t.service),
    webhooks: new RazorpayWebhookService(t.service, client),
    reconciliation: new PaymentReconciliationService(
      t.service,
      client,
      refunds,
    ),
    collection: new CodCollectionService(t.service),
    cod: new CodService(t.service),
    orders: new OrdersService(t.service),
    owner: () =>
      ({ userId: w.alice, tenantId: w.tenantA, role: 'owner' }) as never,
    ownerB: () =>
      ({ userId: w.bob, tenantId: w.tenantB, role: 'owner' }) as never,
    key: (() => {
      let n = 0;
      return () => `world-key-${String(++n).padStart(6, '0')}`;
    })(),

    product: (tenant: string, slug: string, quantity: number, price = 50000) =>
      t.asOwner(async (pg) => {
        const r = await pg.query<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1, $2, $2, $3, $4, 'active') returning id`,
          [tenant, slug, price, quantity],
        );
        return r.rows[0].id;
      }),
    stock: (id: string) =>
      t.asOwner(async (pg) =>
        Number(
          (
            await pg.query<{ quantity: number }>(
              'select quantity from products where id = $1',
              [id],
            )
          ).rows[0].quantity,
        ),
      ),
    one: <T>(query: string, params: unknown[] = []) =>
      t.asOwner(
        async (pg) => (await pg.query<{ v: T }>(query, params)).rows[0]?.v,
      ),
    txOf: (tenant: string, orderNumber: number) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              `select p.* from payment_transactions p join orders o on o.id = p.order_id where o.tenant_id = $1 and o.order_number = $2`,
              [tenant, orderNumber],
            )
          ).rows[0],
      ),
    orderRow: (tenant: string, orderNumber: number) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              'select * from orders where tenant_id = $1 and order_number = $2',
              [tenant, orderNumber],
            )
          ).rows[0],
      ),
    verifyBody: (razorpayOrderId: string, paymentId: string) => ({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: fake.signature(razorpayOrderId, paymentId),
    }),
  };

  /** Owner connects Razorpay, saves a webhook secret and turns payments on. */
  async function connectRazorpay() {
    await payments.save(world.owner(), {
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    });
    await connection.verify(world.owner());
    await connection.setEnabled(world.owner(), true);
  }
  /** An online order placed with its Razorpay order created. */
  async function startOnline(
    slug: string,
    quantity = 1,
    email = 'asha@example.test',
  ) {
    const placed = await checkout.placeOrder(
      'alpha-shop',
      orderBody(slug, quantity, 'razorpay', email),
      world.key(),
    );
    const session = await razorpay.createPayment(
      'alpha-shop',
      placed.orderNumber,
      placed.accessToken!,
    );
    return { placed, session, token: placed.accessToken! };
  }
  /** An online order the shopper has paid and confirmed (captured, stock sold). */
  async function paidOrder(
    slug: string,
    quantity = 1,
    email = 'asha@example.test',
  ) {
    const started = await startOnline(slug, quantity, email);
    const payment = fake.pay(started.session.razorpayOrderId, 'captured');
    await razorpay.verifyPayment(
      'alpha-shop',
      started.placed.orderNumber,
      started.token,
      world.verifyBody(started.session.razorpayOrderId, payment.id),
    );
    const tx = (await world.txOf(w.tenantA, started.placed.orderNumber))!;
    return { ...started, payment, transactionId: tx.id as string };
  }
  return { ...world, connectRazorpay, startOnline, paidOrder };
}

export type PaymentsWorld = Awaited<ReturnType<typeof createPaymentsWorld>>;
