import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { rowsOf } from '../src/database/database.service.js';
import type { PlaceOrderDto } from '../src/modules/orders/checkout.dto.js';
import {
  NoAdjustments,
  type PaymentMethodPolicy,
} from '../src/modules/orders/checkout-hooks.js';
import { PaymentMethodsPolicy } from '../src/modules/payments/payment-methods.policy.js';
import { CheckoutService } from '../src/modules/orders/checkout.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { ReservationExpiryService } from '../src/modules/orders/reservation-expiry.service.js';
import {
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const allowAll: PaymentMethodPolicy = {
  resolve: () => Promise.resolve({ codFeeMinor: 0 }),
};
const config = {
  get: () => ({ reservationMinutes: 30 }),
} as unknown as ConstructorParameters<typeof CheckoutService>[1];

const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};
const order = (
  lines: PlaceOrderDto['lines'],
  paymentMethod: 'razorpay' | 'cod' = 'razorpay',
  email = 'asha@example.test',
): PlaceOrderDto => ({
  lines,
  customer: { fullName: 'Asha Rao', email, phone: '9876543210' },
  shippingAddress: address,
  paymentMethod,
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
  'checkout, reservations and order management (migrations 0045-0046)',
  () => {
    let t: TestDb;
    let w: World;
    let checkout: CheckoutService;
    let orders: OrdersService;
    let expiry: ReservationExpiryService;
    let key = 0;
    const nextKey = () => `test-key-${String(++key).padStart(6, '0')}`;

    const product = (
      tenant: string,
      slug: string,
      quantity: number,
      price = 25000,
      track = true,
    ) =>
      t.asOwner(async (pg) => {
        const res = await pg.query<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, quantity, track_inventory, status)
           values ($1, $2, $2, $3, $4, $5, 'active') returning id`,
          [tenant, slug, price, quantity, track],
        );
        return res.rows[0].id;
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
    const scalar = <T>(query: string, params: unknown[] = []) =>
      t.asOwner(
        async (pg) => (await pg.query<{ v: T }>(query, params)).rows[0]?.v,
      );

    beforeAll(async () => {
      t = await createTestDb();
      w = await seedWorld(t);
      checkout = new CheckoutService(
        t.service,
        config,
        allowAll,
        new NoAdjustments(),
      );
      orders = new OrdersService(t.service);
      expiry = new ReservationExpiryService(t.service);
    });
    afterAll(() => t.close());

    it('prices from the database, holds stock and returns a one-time token', async () => {
      const id = await product(w.tenantA, 'mug-a', 10);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'mug-a', quantity: 3 }]),
        nextKey(),
      );
      expect(placed).toMatchObject({
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        paymentMethod: 'razorpay',
        subtotalMinor: 75000,
        totalMinor: 75000,
        replayed: false,
      });
      expect(placed.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(placed.reservationExpiresAt).toBeInstanceOf(Date);
      expect(placed.items).toEqual([
        {
          name: 'mug-a',
          sku: null,
          quantity: 3,
          unitPriceMinor: 25000,
          totalMinor: 75000,
        },
      ]);
      // Held, not sold: on-hand stock is unchanged until payment.
      expect(await stock(id)).toBe(10);
      expect(
        await scalar(
          'select count(*)::int as v from inventory_reservations where product_id = $1 and status = $2',
          [id, 'active'],
        ),
      ).toBe(1);
      expect(
        await scalar(
          'select count(*)::int as v from order_status_history h join orders o on o.id = h.order_id where o.order_number = $1 and o.tenant_id = $2',
          [placed.orderNumber, w.tenantA],
        ),
      ).toBe(1);
    });

    it('repeats the same order for the same Idempotency-Key and hides the token', async () => {
      await product(w.tenantA, 'mug-idem', 5);
      const k = nextKey();
      const first = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'mug-idem', quantity: 1 }]),
        k,
      );
      const second = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'mug-idem', quantity: 1 }]),
        k,
      );
      expect(second.orderNumber).toBe(first.orderNumber);
      expect(second.replayed).toBe(true);
      expect(second.accessToken).toBeNull();
      expect(
        await scalar(
          'select count(*)::int as v from orders where tenant_id = $1 and idempotency_key = $2',
          [w.tenantA, k],
        ),
      ).toBe(1);
    });

    it('requires an Idempotency-Key', async () => {
      const err = await failure(
        checkout.placeOrder(
          'alpha-shop',
          order([{ productSlug: 'mug-a', quantity: 1 }]),
          undefined,
        ),
      );
      expect(err.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('never oversells the last units, including two simultaneous checkouts', async () => {
      const id = await product(w.tenantA, 'last-two', 2);
      const results = await Promise.allSettled([
        checkout.placeOrder(
          'alpha-shop',
          order(
            [{ productSlug: 'last-two', quantity: 2 }],
            'razorpay',
            'one@example.test',
          ),
          nextKey(),
        ),
        checkout.placeOrder(
          'alpha-shop',
          order(
            [{ productSlug: 'last-two', quantity: 2 }],
            'razorpay',
            'two@example.test',
          ),
          nextKey(),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'CHECKOUT_ISSUES' });
      expect((lost.reason as AppException).details).toEqual({
        issues: [
          {
            code: 'OUT_OF_STOCK',
            productSlug: 'last-two',
            variantId: null,
            available: 0,
          },
        ],
      });
      expect(await stock(id)).toBe(2);
    });

    it('reports a price that changed since the shopper saw it', async () => {
      await product(w.tenantA, 'moving-price', 5, 30000);
      const err = await failure(
        checkout.placeOrder(
          'alpha-shop',
          order([
            {
              productSlug: 'moving-price',
              quantity: 1,
              expectedUnitPriceMinor: 20000,
            },
          ]),
          nextKey(),
        ),
      );
      expect((err.details as { issues: unknown[] }).issues).toEqual([
        {
          code: 'PRICE_CHANGED',
          productSlug: 'moving-price',
          variantId: null,
          currentUnitPriceMinor: 30000,
        },
      ]);
    });

    it('confirms a COD order at once, takes the stock and writes the ledger', async () => {
      const id = await product(w.tenantA, 'cod-item', 6);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'cod-item', quantity: 2 }], 'cod'),
        nextKey(),
      );
      expect(placed).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'pending_collection',
        paymentMethod: 'cod',
      });
      expect(await stock(id)).toBe(4);
      expect(
        await scalar(
          "select delta::int as v from inventory_adjustments where product_id = $1 and reason = 'sale'",
          [id],
        ),
      ).toBe(-2);
    });

    it('cancelling a COD order puts the stock back', async () => {
      const id = await product(w.tenantA, 'cod-cancel', 5);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'cod-cancel', quantity: 2 }], 'cod'),
        nextKey(),
      );
      expect(await stock(id)).toBe(3);
      const cancelled = await checkout.cancelOwnOrder(
        'alpha-shop',
        placed.orderNumber,
        placed.accessToken!,
      );
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.paymentStatus).toBe('unpaid');
      expect(await stock(id)).toBe(5);
    });

    it('lets expired holds go: the job cancels the order and the stock is sellable again', async () => {
      const id = await product(w.tenantA, 'expiring', 1);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'expiring', quantity: 1 }]),
        nextKey(),
      );
      // Held: a second shopper cannot take the only unit...
      expect(
        (
          await failure(
            checkout.placeOrder(
              'alpha-shop',
              order(
                [{ productSlug: 'expiring', quantity: 1 }],
                'razorpay',
                'late@example.test',
              ),
              nextKey(),
            ),
          )
        ).code,
      ).toBe('CHECKOUT_ISSUES');
      // ...until the hold runs out. It stops holding at once, before any job runs.
      await t.asOwner((pg) =>
        pg.query(
          "update inventory_reservations set expires_at = now() - interval '1 minute' where product_id = $1",
          [id],
        ),
      );
      const second = await checkout.placeOrder(
        'alpha-shop',
        order(
          [{ productSlug: 'expiring', quantity: 1 }],
          'razorpay',
          'late@example.test',
        ),
        nextKey(),
      );
      expect(second.status).toBe('pending_payment');
      // The job then closes the stale order and its reservation.
      const result = await expiry.expireDue();
      expect(result.orders).toBeGreaterThanOrEqual(1);
      expect(result.failedTenants).toBe(0);
      const stale = await checkout.getOrder(
        'alpha-shop',
        placed.orderNumber,
        placed.accessToken!,
      );
      expect(stale.status).toBe('cancelled');
      expect(
        await scalar(
          'select r.status as v from inventory_reservations r join orders o on o.id = r.order_id where o.order_number = $1 and o.tenant_id = $2',
          [placed.orderNumber, w.tenantA],
        ),
      ).toBe('expired');
      expect(await stock(id)).toBe(1);
    });

    it('shows an order only with its own token, and only inside its own store', async () => {
      await product(w.tenantA, 'private-order', 3);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'private-order', quantity: 1 }]),
        nextKey(),
      );
      expect(
        (
          await checkout.getOrder(
            'alpha-shop',
            placed.orderNumber,
            placed.accessToken!,
          )
        ).orderNumber,
      ).toBe(placed.orderNumber);
      expect(
        (
          await failure(
            checkout.getOrder('alpha-shop', placed.orderNumber, 'wrong-token'),
          )
        ).code,
      ).toBe('ORDER_NOT_FOUND');
      expect(
        (
          await failure(
            checkout.getOrder('alpha-shop', placed.orderNumber, undefined),
          )
        ).code,
      ).toBe('ORDER_NOT_FOUND');
      // The same number and token asked of another tenant's store finds nothing.
      expect(
        (
          await failure(
            checkout.getOrder(
              'beta-shop',
              placed.orderNumber,
              placed.accessToken!,
            ),
          )
        ).code,
      ).toBe('ORDER_NOT_FOUND');
    });

    it("cannot buy another store's product through your own store", async () => {
      await product(w.tenantB, 'only-in-beta', 5);
      const err = await failure(
        checkout.placeOrder(
          'alpha-shop',
          order([{ productSlug: 'only-in-beta', quantity: 1 }]),
          nextKey(),
        ),
      );
      expect(
        (err.details as { issues: { code: string }[] }).issues[0].code,
      ).toBe('PRODUCT_UNAVAILABLE');
    });

    it('treats an unknown or inactive store as not found', async () => {
      expect(
        (
          await failure(
            checkout.placeOrder(
              'nope-shop',
              order([{ productSlug: 'x', quantity: 1 }]),
              nextKey(),
            ),
          )
        ).code,
      ).toBe('STORE_NOT_FOUND');
      await t.asOwner((pg) =>
        pg.query("update stores set status = 'inactive' where tenant_id = $1", [
          w.tenantB,
        ]),
      );
      expect(
        (
          await failure(
            checkout.placeOrder(
              'beta-shop',
              order([{ productSlug: 'only-in-beta', quantity: 1 }]),
              nextKey(),
            ),
          )
        ).code,
      ).toBe('STORE_NOT_FOUND');
      await t.asOwner((pg) =>
        pg.query("update stores set status = 'active' where tenant_id = $1", [
          w.tenantB,
        ]),
      );
    });

    it('refuses payment methods the store has not set up', async () => {
      const bare = new CheckoutService(
        t.service,
        config,
        new PaymentMethodsPolicy(),
        new NoAdjustments(),
      );
      await product(w.tenantA, 'no-payments', 3);
      expect(
        (
          await failure(
            bare.placeOrder(
              'alpha-shop',
              order([{ productSlug: 'no-payments', quantity: 1 }]),
              nextKey(),
            ),
          )
        ).code,
      ).toBe('PAYMENT_METHOD_UNAVAILABLE');
      // Nothing was written: the whole transaction rolled back, so no reservation or order exists.
      expect(
        await scalar(
          "select count(*)::int as v from inventory_reservations r join products p on p.id = r.product_id where p.slug = 'no-payments'",
        ),
      ).toBe(0);
    });

    it('rejects a delivery state that does not exist', async () => {
      await product(w.tenantA, 'state-check', 3);
      const bad = order([{ productSlug: 'state-check', quantity: 1 }]);
      bad.shippingAddress = { ...address, state: 'Atlantis' };
      expect(
        (await failure(checkout.placeOrder('alpha-shop', bad, nextKey()))).kind,
      ).toBe('VALIDATION');
    });

    it('lets the Owner move an order along its lifecycle, but only to valid next steps', async () => {
      await product(w.tenantA, 'lifecycle', 3);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'lifecycle', quantity: 1 }], 'cod'),
        nextKey(),
      );
      const id = (await scalar<string>(
        'select id as v from orders where tenant_id = $1 and order_number = $2',
        [w.tenantA, placed.orderNumber],
      ))!;
      const ctx = {
        userId: w.alice,
        tenantId: w.tenantA,
        role: 'owner',
      } as never;

      const skipped = await failure(
        orders.updateStatus(ctx, id, { status: 'delivered' }),
      );
      expect(skipped.code).toBe('ORDER_INVALID_TRANSITION');
      const processing = await orders.updateStatus(ctx, id, {
        status: 'processing',
        note: 'Packing',
      });
      expect(processing.status).toBe('processing');
      expect(processing.nextStatuses).toEqual(['ready_to_ship', 'cancelled']);
      expect(processing.history.map((h) => h.toStatus)).toEqual([
        'confirmed',
        'processing',
      ]);
      expect(processing.history[1]).toMatchObject({
        actorType: 'owner',
        note: 'Packing',
      });

      // A different organization's Owner cannot see or change it.
      const bobCtx = {
        userId: w.bob,
        tenantId: w.tenantB,
        role: 'owner',
      } as never;
      expect((await failure(orders.get(bobCtx, id))).code).toBe(
        'ORDER_NOT_FOUND',
      );
      expect(
        (
          await failure(
            orders.updateStatus(bobCtx, id, { status: 'ready_to_ship' }),
          )
        ).code,
      ).toBe('ORDER_NOT_FOUND');

      const list = await orders.list(ctx, {
        page: 1,
        limit: 50,
        search: '',
        sortOrder: 'desc',
        status: 'processing',
      } as never);
      expect(list.items.map((o) => o.orderNumber)).toContain(
        placed.orderNumber,
      );
    });

    it('will not cancel an order whose money was received without a refund', async () => {
      await product(w.tenantA, 'paid-order', 3);
      const placed = await checkout.placeOrder(
        'alpha-shop',
        order([{ productSlug: 'paid-order', quantity: 1 }]),
        nextKey(),
      );
      await t.asOwner((pg) =>
        pg.query(
          "update orders set payment_status = 'paid', status = 'confirmed' where tenant_id = $1 and order_number = $2",
          [w.tenantA, placed.orderNumber],
        ),
      );
      const id = (await scalar<string>(
        'select id as v from orders where tenant_id = $1 and order_number = $2',
        [w.tenantA, placed.orderNumber],
      ))!;
      const ctx = {
        userId: w.alice,
        tenantId: w.tenantA,
        role: 'owner',
      } as never;
      expect(
        (await failure(orders.cancel(ctx, id, { reason: 'Changed mind' })))
          .code,
      ).toBe('REFUND_REQUIRED');
    });

    it('numbers orders per tenant without gaps or collisions', async () => {
      const a = await scalar<number>(
        'select max(order_number)::int as v from orders where tenant_id = $1',
        [w.tenantA],
      );
      const counter = await scalar<number>(
        'select last_number::int as v from tenant_order_counters where tenant_id = $1',
        [w.tenantA],
      );
      expect(counter).toBe(a);
      const rows = rowsOf<{ n: number }>(
        await t.service.withCheckout(w.tenantA, (tx) =>
          tx.execute(
            sql`select count(distinct order_number)::int as n from orders`,
          ),
        ),
      );
      expect(rows[0].n).toBe(
        await scalar<number>(
          'select count(*)::int as v from orders where tenant_id = $1',
          [w.tenantA],
        ),
      );
    });
  },
);
