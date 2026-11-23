import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import {
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

/** SQLSTATE of an error, however many wrappers it travelled through. */
function sqlstate(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code))
      return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return sqlstate(error) ?? 'error';
  }
}

describe.skipIf(!migrationsAvailable)(
  'order lifecycle database (migration 0045)',
  () => {
    let t: TestDb;
    let w: World;

    const placeOrder = (
      tx: Parameters<Parameters<TestDb['service']['withCheckout']>[1]>[0],
      tenant: string,
      n: number,
      extra: { key?: string; total?: number; subtotal?: number } = {},
    ) =>
      tx.execute(sql`
        insert into orders (tenant_id, order_number, currency, subtotal_minor, shipping_minor, total_minor, payment_method, idempotency_key)
        values (${tenant}::uuid, ${n}, 'INR', ${extra.subtotal ?? 1000}, 100, ${extra.total ?? 1100}, 'razorpay', ${extra.key ?? null})
        returning id`);

    beforeAll(async () => {
      t = await createTestDb();
      w = await seedWorld(t);
    });
    afterAll(() => t.close());

    it('lets the checkout role write only inside the tenant it is pinned to', async () => {
      await t.service.withCheckout(w.tenantA, async (tx) => {
        await placeOrder(tx, w.tenantA, 9001);
      });
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            placeOrder(tx, w.tenantB, 9002),
          ),
        ),
      ).toBe('42501');
    });

    it("never shows the checkout role another tenant's orders", async () => {
      await t.asOwner((pg) =>
        pg.query(
          `insert into orders (tenant_id, order_number, currency, subtotal_minor, total_minor)
           values ($1, 9100, 'INR', 500, 500)`,
          [w.tenantB],
        ),
      );
      const seenByA = await t.service.withCheckout(w.tenantA, async (tx) =>
        rowsOf<{ tenant_id: string }>(
          await tx.execute(sql`select tenant_id from orders`),
        ),
      );
      expect(seenByA.length).toBeGreaterThan(0);
      expect(seenByA.every((r) => r.tenant_id === w.tenantA)).toBe(true);
    });

    it('sees nothing when no tenant is pinned (the pin is empty)', async () => {
      const rows = await t.service.withCheckout(
        '00000000-0000-0000-0000-000000000000',
        async (tx) => rowsOf(await tx.execute(sql`select id from orders`)),
      );
      expect(rows).toEqual([]);
    });

    it('cannot reach payment credentials at all', async () => {
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            tx.execute(sql`select tenant_id from tenant_razorpay_config`),
          ),
        ),
      ).toBe('42501');
    });

    it('rejects an order whose total does not match its breakdown', async () => {
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            placeOrder(tx, w.tenantA, 9003, { total: 5 }),
          ),
        ),
      ).toBe('23514');
    });

    it('rejects a second order with the same idempotency key, per tenant', async () => {
      await t.service.withCheckout(w.tenantA, (tx) =>
        placeOrder(tx, w.tenantA, 9004, { key: 'checkout-key-0001' }),
      );
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            placeOrder(tx, w.tenantA, 9005, { key: 'checkout-key-0001' }),
          ),
        ),
      ).toBe('23505');
      // The same key in another tenant is a different order.
      expect(
        await outcome(
          t.service.withCheckout(w.tenantB, (tx) =>
            placeOrder(tx, w.tenantB, 9006, { key: 'checkout-key-0001' }),
          ),
        ),
      ).toBe('ok');
    });

    it('refuses a COD fee on a non-COD order and unknown lifecycle values', async () => {
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            tx.execute(sql`
              insert into orders (tenant_id, order_number, currency, subtotal_minor, cod_fee_minor, total_minor, payment_method)
              values (${w.tenantA}::uuid, 9007, 'INR', 1000, 50, 1050, 'razorpay')`),
          ),
        ),
      ).toBe('23514');
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            tx.execute(
              sql`update orders set status = 'paid' where order_number = 9001`,
            ),
          ),
        ),
      ).toBe('23514');
    });

    it('keeps a reservation active until it is resolved', async () => {
      const product = await t.asOwner(async (pg) => {
        const res = await pg.query<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status)
           values ($1, 'Mug', 'mug-res', 1000, 5, 'active') returning id`,
          [w.tenantA],
        );
        return res.rows[0].id;
      });
      const orderId = await t.service.withCheckout(w.tenantA, async (tx) => {
        const [o] = rowsOf<{ id: string }>(
          await placeOrder(tx, w.tenantA, 9008),
        );
        await tx.execute(sql`
          insert into inventory_reservations (tenant_id, order_id, product_id, quantity, expires_at)
          values (${w.tenantA}::uuid, ${o.id}::uuid, ${product}::uuid, 2, now() + interval '15 minutes')`);
        return o.id;
      });
      // Resolving without a timestamp, or stamping an active one, violates the CHECK.
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            tx.execute(
              sql`update inventory_reservations set status = 'released' where order_id = ${orderId}::uuid`,
            ),
          ),
        ),
      ).toBe('23514');
      expect(
        await outcome(
          t.service.withCheckout(w.tenantA, (tx) =>
            tx.execute(
              sql`update inventory_reservations set status = 'released', resolved_at = now() where order_id = ${orderId}::uuid`,
            ),
          ),
        ),
      ).toBe('ok');
    });
  },
);
