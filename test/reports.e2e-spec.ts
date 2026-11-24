import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { sql } from 'drizzle-orm';
import {
  asUser,
  createTestDb,
  createUser,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const RANGE = 'from=2026-03-01&to=2026-03-31';

/**
 * One small, fully worked-out month (store time zone Asia/Kolkata, UTC+5:30). Orders that count as sales are o2, o3, o5, o7:
 *   gross 430000, discounts 25000, refunds 30000 (o7 only), net sales 375000, fees 8000, total sales 413000, net revenue 383000.
 * The others are left out on purpose: o1 and o8 are outside the month, o4 cancelled, o6 unpaid, o9 cancelled AFTER being refunded.
 */
describe.skipIf(!migrationsAvailable)(
  'sales, revenue, product and customer reports (migration 0056)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let nobody: Awaited<ReturnType<typeof as>>;
    let cx = '';
    let cy = '';
    let cz = '';

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner(async (pg) => {
        const customer = async (
          name: string,
          email: string,
          createdAt: string,
        ) =>
          (
            await pg.query<{ id: string }>(
              `insert into customers (tenant_id, full_name, email, created_at) values ($1,$2,$3,$4) returning id`,
              [w.tenantA, name, email, createdAt],
            )
          ).rows[0].id;
        cx = await customer('Xavier', 'x@example.test', '2026-01-10T00:00:00Z');
        cy = await customer('Yamini', 'y@example.test', '2026-03-05T06:00:00Z');
        cz = await customer('Zoya', 'z@example.test', '2026-03-20T06:00:00Z');

        const product = async (name: string, slug: string, status: string) =>
          (
            await pg.query<{ id: string }>(
              `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1,$2,$3,1000,100,$4) returning id`,
              [w.tenantA, name, slug, status],
            )
          ).rows[0].id;
        const mug = await product('Mug', 'rp-mug', 'active');
        const pen = await product('Pen', 'rp-pen', 'active');
        const lamp = await product('Lamp', 'rp-lamp', 'active');
        const old = await product('Old thing', 'rp-old', 'draft');
        await product('Unsold draft', 'rp-unsold', 'draft');

        const order = async (
          n: number,
          customerId: string,
          status: string,
          placedAt: string,
          subtotal: number,
          discount: number,
          shipping: number,
          cod: number,
          total: number,
          items: [string, string, number, number][],
        ) => {
          const id = (
            await pg.query<{ id: string }>(
              `insert into orders (tenant_id, customer_id, order_number, status, currency, subtotal_minor, discount_minor,
                 shipping_minor, cod_fee_minor, total_minor, placed_at)
               values ($1,$2,$3,$4,'INR',$5,$6,$7,$8,$9,$10) returning id`,
              [
                w.tenantA,
                customerId,
                n,
                status,
                subtotal,
                discount,
                shipping,
                cod,
                total,
                placedAt,
              ],
            )
          ).rows[0].id;
          for (const [productId, name, quantity, lineTotal] of items)
            await pg.query(
              `insert into order_items (tenant_id, order_id, product_id, name, quantity, unit_price_minor, total_minor)
               values ($1,$2,$3,$4,$5,$6,$7)`,
              [
                w.tenantA,
                id,
                productId,
                name,
                quantity,
                Math.round(lineTotal / quantity),
                lineTotal,
              ],
            );
          return id;
        };
        const txOf = new Map<string, string>();
        const refund = async (
          orderId: string,
          amount: number,
          key: string,
          status = 'processed',
        ) => {
          if (!txOf.has(orderId))
            txOf.set(
              orderId,
              (
                await pg.query<{ id: string }>(
                  `insert into payment_transactions (tenant_id, order_id, provider, status, amount_minor, currency, razorpay_order_id, razorpay_payment_id)
                   values ($1,$2,'razorpay','captured',$3,'INR',$4,$5) returning id`,
                  [w.tenantA, orderId, 1_000_000, `order_${key}`, `pay_${key}`],
                )
              ).rows[0].id,
            );
          await pg.query(
            `insert into refunds (tenant_id, order_id, payment_transaction_id, amount_minor, currency, status, idempotency_key, processed_at)
             values ($1,$2,$3,$4,'INR',$5,$6, case when $5 = 'processed' then now() end)`,
            [w.tenantA, orderId, txOf.get(orderId), amount, status, key],
          );
        };

        await order(
          1,
          cx,
          'delivered',
          '2026-02-15T10:00:00Z',
          100000,
          0,
          0,
          0,
          100000,
          [[mug, 'Mug', 9, 100000]],
        );
        await order(
          2,
          cx,
          'delivered',
          '2026-03-02T10:00:00Z',
          200000,
          20000,
          5000,
          0,
          185000,
          [
            [mug, 'Mug', 3, 150000],
            [pen, 'Pen', 5, 50000],
          ],
        );
        await order(
          3,
          cy,
          'confirmed',
          '2026-03-02T11:00:00Z',
          100000,
          0,
          0,
          3000,
          103000,
          [[mug, 'Mug', 1, 100000]],
        );
        await order(
          4,
          cy,
          'cancelled',
          '2026-03-03T10:00:00Z',
          500000,
          0,
          0,
          0,
          500000,
          [[lamp, 'Lamp', 10, 500000]],
        );
        // 2026-03-11 00:30 in India: the 11th, though it is still the 10th in UTC.
        await order(
          5,
          cz,
          'shipped',
          '2026-03-10T19:00:00Z',
          50000,
          5000,
          0,
          0,
          45000,
          [[pen, 'Pen', 5, 50000]],
        );
        await order(
          6,
          cx,
          'pending_payment',
          '2026-03-12T10:00:00Z',
          70000,
          0,
          0,
          0,
          70000,
          [],
        );
        // 2026-03-31 01:30 in India: the last day of the month, though it is still the 30th in UTC.
        const o7 = await order(
          7,
          cx,
          'delivered',
          '2026-03-30T20:00:00Z',
          80000,
          0,
          0,
          0,
          80000,
          [[old, 'Old thing', 1, 80000]],
        );
        await order(
          8,
          cy,
          'delivered',
          '2026-04-01T00:00:00Z',
          60000,
          0,
          0,
          0,
          60000,
          [],
        );
        const o9 = await order(
          9,
          cz,
          'cancelled',
          '2026-03-15T10:00:00Z',
          10000,
          0,
          0,
          0,
          10000,
          [],
        );
        await refund(o7, 30000, 'refund-order-7');
        await refund(o9, 10000, 'refund-order-9');
        await refund(o7, 5000, 'refund-order-7-failed', 'failed');
        await refund(o7, 7000, 'refund-order-7-pending', 'pending');
      });
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      nobody = await as(t, w.members.nothing, w.tenantA);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('sales overview', () => {
      it('adds up the orders that count, and nothing else', async () => {
        const r = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data;
        expect(r).toMatchObject({
          from: '2026-03-01',
          to: '2026-03-31',
          interval: 'day',
          currency: 'INR',
          timeZone: 'Asia/Kolkata',
        });
        expect(r.totals).toEqual({
          orders: 4,
          grossSalesMinor: 430000,
          discountsMinor: 25000,
          refundsMinor: 30000,
          netSalesMinor: 375000,
          shippingAndFeesMinor: 8000,
          taxMinor: 0,
          totalSalesMinor: 413000,
          netRevenueMinor: 383000,
          averageOrderValueMinor: 103250,
        });
      });

      it('does not subtract the refund of an order that was cancelled, failed or is still pending', async () => {
        const r = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data;
        // 10000 (cancelled order), 5000 (failed) and 7000 (pending) are not in 30000.
        expect(r.totals.refundsMinor).toBe(30000);
      });

      it('has a daily series with no gaps whose points add up to the totals', async () => {
        const r = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data;
        expect(r.series).toHaveLength(31);
        expect(r.series[0].period).toBe('2026-03-01');
        expect(r.series[30].period).toBe('2026-03-31');
        const byDay = Object.fromEntries(
          r.series.map((p: { period: string }) => [p.period, p]),
        );
        expect(byDay['2026-03-02']).toMatchObject({
          orders: 2,
          grossSalesMinor: 300000,
          discountsMinor: 20000,
          totalSalesMinor: 288000,
        });
        // Days are the store's days: 00:30 India time on the 11th, 01:30 on the 31st.
        expect(byDay['2026-03-10'].orders).toBe(0);
        expect(byDay['2026-03-11']).toMatchObject({
          orders: 1,
          grossSalesMinor: 50000,
        });
        expect(byDay['2026-03-30'].orders).toBe(0);
        expect(byDay['2026-03-31']).toMatchObject({
          orders: 1,
          refundsMinor: 30000,
          netSalesMinor: 50000,
        });
        expect(byDay['2026-03-05']).toMatchObject({
          orders: 0,
          totalSalesMinor: 0,
          averageOrderValueMinor: 0,
        });
        const sum = (k: string) =>
          r.series.reduce(
            (n: number, p: Record<string, number>) => n + p[k],
            0,
          );
        for (const k of [
          'orders',
          'grossSalesMinor',
          'discountsMinor',
          'refundsMinor',
          'netSalesMinor',
          'totalSalesMinor',
          'netRevenueMinor',
        ])
          expect(sum(k), k).toBe(r.totals[k]);
      });

      it('keeps the charge identity: items - discounts + delivery and fees', async () => {
        const t = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data.totals;
        expect(t.totalSalesMinor).toBe(
          t.grossSalesMinor - t.discountsMinor + t.shippingAndFeesMinor + 0,
        );
      });

      it('compares with the period just before', async () => {
        const r = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data;
        expect(r.previous).toMatchObject({
          from: '2026-01-29',
          to: '2026-02-28',
        });
        expect(r.previous.figures).toMatchObject({
          orders: 1,
          grossSalesMinor: 100000,
          totalSalesMinor: 100000,
        });
        expect(r.previous.changePercent).toMatchObject({
          orders: 300,
          totalSalesMinor: 313,
        });
        const empty = (
          await alice
            .get('/analytics/sales?from=2026-01-01&to=2026-01-10')
            .expect(200)
        ).body.data;
        expect(empty.totals.orders).toBe(0);
        expect(empty.previous.changePercent.orders).toBeNull();
      });

      it('works with no dates at all (the last 30 days)', async () => {
        const r = (await alice.get('/analytics/sales').expect(200)).body.data;
        expect(r.series).toHaveLength(30);
        expect(r.totals.orders).toBe(0);
      });
    });

    describe('revenue report by day, week and month', () => {
      it('groups by week starting Monday, without gaps', async () => {
        const r = (
          await alice
            .get(`/analytics/revenue?${RANGE}&interval=week`)
            .expect(200)
        ).body.data;
        expect(
          r.series.map((p: { period: string; orders: number }) => [
            p.period,
            p.orders,
          ]),
        ).toEqual([
          ['2026-02-23', 0],
          ['2026-03-02', 2],
          ['2026-03-09', 1],
          ['2026-03-16', 0],
          ['2026-03-23', 0],
          ['2026-03-30', 1],
        ]);
        expect(r.series[5]).toMatchObject({
          refundsMinor: 30000,
          netSalesMinor: 50000,
        });
        expect(r.totals.netSalesMinor).toBe(375000);
      });

      it('groups by month', async () => {
        const r = (
          await alice
            .get(
              '/analytics/revenue?from=2026-02-01&to=2026-04-30&interval=month',
            )
            .expect(200)
        ).body.data;
        expect(
          r.series.map(
            (p: {
              period: string;
              orders: number;
              totalSalesMinor: number;
            }) => [p.period, p.orders, p.totalSalesMinor],
          ),
        ).toEqual([
          ['2026-02-01', 1, 100000],
          ['2026-03-01', 4, 413000],
          ['2026-04-01', 1, 60000],
        ]);
      });

      it('agrees with the overview for the same period', async () => {
        const a = (await alice.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data.totals;
        for (const interval of ['day', 'week', 'month']) {
          const b = (
            await alice
              .get(`/analytics/revenue?${RANGE}&interval=${interval}`)
              .expect(200)
          ).body.data.totals;
          expect(b, interval).toEqual(a);
        }
      });

      it('refuses what it cannot answer', async () => {
        await alice.get('/analytics/sales?interval=hour').expect(400);
        await alice.get('/analytics/sales?from=2026-02-30').expect(400);
        await alice
          .get('/analytics/sales?from=2026-03-10&to=2026-03-01')
          .expect(400);
        await alice
          .get('/analytics/sales?from=2024-01-01&to=2026-01-01')
          .expect(400);
        await alice
          .get(
            '/analytics/revenue?from=2024-01-01&to=2026-01-01&interval=month',
          )
          .expect(200);
        await alice.get('/analytics/sales?from=yesterday').expect(400);
      });
    });

    describe('product performance', () => {
      const ranked = async (q: string) =>
        (await alice.get(`/analytics/products?${RANGE}&${q}`).expect(200)).body;

      it('ranks best sellers, with units, revenue and orders containing the product', async () => {
        const b = await ranked('sortBy=units');
        expect(b.data.map((p: { slug: string }) => p.slug)).toEqual([
          'rp-pen',
          'rp-mug',
          'rp-old',
          'rp-lamp',
        ]);
        expect(b.data[0]).toMatchObject({
          unitsSold: 10,
          revenueMinor: 100000,
          orders: 2,
          conversionRatePercent: null,
        });
        expect(b.data[1]).toMatchObject({
          unitsSold: 4,
          revenueMinor: 250000,
          orders: 2,
        });
        expect(b.meta.total).toBe(4);
      });

      it('ranks the worst performers first, including active products nobody bought, but not unsold drafts', async () => {
        const w = await ranked('sortBy=units&sortOrder=asc');
        expect(w.data.map((p: { slug: string }) => p.slug)).toEqual([
          'rp-lamp',
          'rp-old',
          'rp-mug',
          'rp-pen',
        ]);
        expect(w.data[0]).toMatchObject({
          unitsSold: 0,
          revenueMinor: 0,
          orders: 0,
        });
      });

      it('can rank by revenue, search and page', async () => {
        expect(
          (await ranked('sortBy=revenue')).data.map(
            (p: { slug: string }) => p.slug,
          ),
        ).toEqual(['rp-mug', 'rp-pen', 'rp-old', 'rp-lamp']);
        expect((await ranked('search=pen')).data).toHaveLength(1);
        const page = await ranked('limit=2&page=2');
        expect(page.data.map((p: { slug: string }) => p.slug)).toEqual([
          'rp-old',
          'rp-lamp',
        ]);
        await alice.get('/analytics/products?sortBy=profit').expect(400);
      });

      it('leaves out orders that do not count (the cancelled lamp order)', async () => {
        const lamp = (await ranked('search=lamp')).data[0];
        expect(lamp.unitsSold).toBe(0);
      });

      it('respects the date range', async () => {
        const feb = (
          await alice
            .get(
              '/analytics/products?from=2026-02-01&to=2026-02-28&sortBy=units',
            )
            .expect(200)
        ).body.data;
        expect(feb[0]).toMatchObject({ slug: 'rp-mug', unitsSold: 9 });
      });
    });

    describe('customer analytics', () => {
      it('splits buyers into first-time and returning and works out repeat rate and spend', async () => {
        const c = (await alice.get(`/analytics/customers?${RANGE}`).expect(200))
          .body.data;
        expect(c).toEqual({
          from: '2026-03-01',
          to: '2026-03-31',
          totalCustomers: 3,
          newCustomers: 2,
          buyers: 3,
          firstTimeBuyers: 2,
          returningCustomers: 1,
          repeatPurchaseRatePercent: 66.7,
          averageOrdersPerBuyer: 1.3,
          averageSpendPerBuyerMinor: 137667,
          averageOrderValueMinor: 103250,
        });
      });

      it('lists the top customers by revenue, or by orders, a page at a time', async () => {
        const top = (
          await alice.get(`/analytics/customers/top?${RANGE}`).expect(200)
        ).body;
        expect(
          top.data.map(
            (c: { email: string; revenueMinor: number; orders: number }) => [
              c.email,
              c.revenueMinor,
              c.orders,
            ],
          ),
        ).toEqual([
          ['x@example.test', 265000, 2],
          ['y@example.test', 103000, 1],
          ['z@example.test', 45000, 1],
        ]);
        expect(top.meta.total).toBe(3);
        const second = (
          await alice
            .get(`/analytics/customers/top?${RANGE}&limit=1&page=2`)
            .expect(200)
        ).body.data;
        expect(second.map((c: { email: string }) => c.email)).toEqual([
          'y@example.test',
        ]);
        expect(
          (
            await alice
              .get(`/analytics/customers/top?${RANGE}&search=zoya`)
              .expect(200)
          ).body.data,
        ).toHaveLength(1);
        await alice.get('/analytics/customers/top?sortBy=age').expect(400);
      });

      it('shows the purchase history of one customer', async () => {
        const h = (
          await alice.get(`/analytics/customers/${cx}/history`).expect(200)
        ).body.data;
        expect(h).toMatchObject({
          customerId: cx,
          fullName: 'Xavier',
          lifetimeOrders: 3,
          lifetimeRevenueMinor: 365000,
          averageOrderValueMinor: 121667,
          totalOrders: 4,
        });
        expect(
          h.orders.map((o: { orderNumber: number; countsAsSale: boolean }) => [
            o.orderNumber,
            o.countsAsSale,
          ]),
        ).toEqual([
          [7, true],
          [6, false],
          [2, true],
          [1, true],
        ]);
        expect(h.orders[2]).toMatchObject({
          itemCount: 8,
          discountMinor: 20000,
          totalMinor: 185000,
        });
        const page = (
          await alice
            .get(`/analytics/customers/${cx}/history?limit=1&page=2`)
            .expect(200)
        ).body.data;
        expect(
          page.orders.map((o: { orderNumber: number }) => o.orderNumber),
        ).toEqual([6]);
        await alice
          .get(
            '/analytics/customers/00000000-0000-4000-8000-000000000000/history',
          )
          .expect(404);
        await alice.get('/analytics/customers/not-a-uuid/history').expect(400);
      });
    });

    describe('members whose access is not the whole picture (migration 0059)', () => {
      let customersOnly: Awaited<ReturnType<typeof as>>;
      let ordersOnly: Awaited<ReturnType<typeof as>>;

      beforeAll(async () => {
        const member = async (email: string, permissions: object) => {
          const id = await createUser(t.db, email, email);
          await t.db.asOwner((pg) =>
            pg.query(
              "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin',$3::jsonb,'active')",
              [w.tenantA, id, JSON.stringify(permissions)],
            ),
          );
          return as(t, id, w.tenantA);
        };
        customersOnly = await member('customers-only@example.test', {
          products: 'none',
          orders: 'none',
          customers: 'read',
          settings: 'read',
          design: 'none',
        });
        ordersOnly = await member('orders-only@example.test', {
          products: 'none',
          orders: 'read',
          customers: 'none',
          settings: 'read',
          design: 'none',
        });
      });

      it('answer a member who may see customers but not orders with a refusal, never with a report of zeros', async () => {
        for (const path of [
          '/analytics/customers',
          '/analytics/customers/top',
          `/analytics/customers/${cx}/history`,
        ]) {
          const res = await customersOnly.get(path).expect(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
        await customersOnly.get('/analytics/sales').expect(403);
        await customersOnly.get('/analytics/products').expect(403);
      });

      it('show a member who may see orders but not the catalogue the real product report, not an empty one', async () => {
        const r = (
          await ordersOnly.get(`/analytics/products?${RANGE}`).expect(200)
        ).body;
        expect(r.data.map((p: { slug: string }) => p.slug)).toEqual([
          'rp-pen',
          'rp-mug',
          'rp-old',
          'rp-lamp',
        ]);
        expect(
          (await ordersOnly.get(`/analytics/sales?${RANGE}`).expect(200)).body
            .data.totals.netSalesMinor,
        ).toBe(375000);
        await ordersOnly.get('/analytics/customers').expect(403);
        await ordersOnly.get('/products').expect(403);
      });

      it('refuse the report functions to anyone who is not a member of the store, even when called directly', async () => {
        const call = (user: string, fn: string) =>
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql.raw(
                `select count(*) from public.${fn}('${w.tenantA}'::uuid)`,
              ),
            ),
          );
        for (const fn of ['report_products', 'report_customers'])
          await expect(call(w.bob, fn)).rejects.toThrow();
        await expect(
          asUser(t.db, w.bob, (tx) =>
            tx.execute(
              sql.raw(
                `select count(*) from public.report_counted_orders('${w.tenantA}'::uuid, null, null, array['delivered'])`,
              ),
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, w.bob, (tx) =>
            tx.execute(
              sql.raw(
                `select count(*) from public.report_counted_items('${w.tenantA}'::uuid, null, null, array['delivered'])`,
              ),
            ),
          ),
        ).rejects.toThrow();
      });

      it('give nothing to the anonymous role', async () => {
        const rows = await t.db.asOwner((pg) =>
          pg.query<{ fn: string; anon: boolean; authed: boolean }>(
            `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authed
             from pg_proc p where p.proname in ('report_counted_orders','report_counted_items','report_products','report_customers')`,
          ),
        );
        expect(rows.rows).toHaveLength(4);
        for (const r of rows.rows)
          expect(r).toMatchObject({ anon: false, authed: true });
      });

      it("count one customer's history only from that store", async () => {
        await bob.get(`/analytics/customers/${cx}/history`).expect(404);
      });
    });

    describe('access and isolation', () => {
      it('needs a signed-in member of the store with the right access', async () => {
        const { default: request } = await import('supertest');
        await request(t.app.getHttpServer())
          .get('/api/v1/analytics/sales')
          .expect(401);
        for (const path of [
          'sales',
          'revenue',
          'products',
          'customers',
          'customers/top',
        ])
          await nobody.get(`/analytics/${path}`).expect(403);
        await nobody.get(`/analytics/customers/${cx}/history`).expect(403);
      });

      it('shows a read-only member the same refunds as the Owner, though refunds themselves are Owner-only', async () => {
        const mine = (await reader.get(`/analytics/sales?${RANGE}`).expect(200))
          .body.data;
        expect(mine.totals.refundsMinor).toBe(30000);
        expect(mine.totals.netSalesMinor).toBe(375000);
        await reader.get('/payments/refunds').expect(403);
      });

      it('shows another store none of this', async () => {
        const r = (await bob.get(`/analytics/sales?${RANGE}`).expect(200)).body
          .data;
        expect(r.totals).toMatchObject({
          orders: 0,
          grossSalesMinor: 0,
          refundsMinor: 0,
          totalSalesMinor: 0,
        });
        expect(
          (await bob.get(`/analytics/products?${RANGE}`).expect(200)).body.data,
        ).toEqual([]);
        expect(
          (await bob.get(`/analytics/customers/top?${RANGE}`).expect(200)).body
            .data,
        ).toEqual([]);
        expect(
          (await bob.get(`/analytics/customers?${RANGE}`).expect(200)).body.data
            .totalCustomers,
        ).toBe(0);
        await bob.get(`/analytics/customers/${cx}/history`).expect(404);
        await (
          await as(t, w.alice, w.tenantB)
        )
          .get(`/analytics/sales?${RANGE}`)
          .expect(403);
      });

      it('leaves the existing dashboard analytics alone', async () => {
        const home = (await alice.get('/analytics').expect(200)).body.data;
        expect(home).toHaveProperty('hasOrders', true);
      });
    });
  },
);
