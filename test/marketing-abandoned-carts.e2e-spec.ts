import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { sql } from 'drizzle-orm';
import { CartRecoveryService } from '../src/modules/marketing/cart-recovery.service.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef-xyz';
const KEY_ENV = [
  'CREDENTIALS_ENCRYPTION_KEY_V1',
  'CREDENTIALS_ENCRYPTION_KEY_CURRENT',
] as const;

describe.skipIf(!migrationsAvailable)(
  'abandoned carts over HTTP: checkpoint, abandonment, recovery links, conversion, isolation (migration 0055)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let nobody: Awaited<ReturnType<typeof as>>;
    const anon = () => request(t.app.getHttpServer());
    const api = (p: string) => `/api/v1${p}`;
    let n = 0;
    const ip = () =>
      `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const newKey = () => randomBytes(18).toString('base64url');
    const MUG = { productSlug: 'ac-mug', quantity: 2 }; // 2 x 50000
    const PEN = { productSlug: 'ac-pen', quantity: 1 }; // 10000

    const checkpoint = (
      over: Record<string, unknown> = {},
      store = 'alpha-shop',
    ) =>
      anon()
        .post(api(`/public/stores/${store}/cart/checkpoint`))
        .set('X-Forwarded-For', ip())
        .send({
          cartKey: newKey(),
          lines: [MUG],
          customer: {
            email: `shopper${++n}@example.test`,
            fullName: 'Asha Rao',
          },
          ...over,
        });
    const open = (token: string, store = 'alpha-shop') =>
      anon()
        .get(api(`/public/stores/${store}/cart/recovery/${token}`))
        .set('X-Forwarded-For', ip());
    const order = (email: string, cartKey?: string, lines: object[] = [PEN]) =>
      anon()
        .post(api('/public/stores/alpha-shop/orders'))
        .set('X-Forwarded-For', ip())
        .set('Idempotency-Key', randomBytes(12).toString('hex'))
        .send({
          lines,
          customer: { fullName: 'Asha Rao', email, phone: '9876543210' },
          shippingAddress: {
            fullName: 'Asha Rao',
            phone: '9876543210',
            line1: '12 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
          paymentMethod: 'cod',
          ...(cartKey ? { cartKey } : {}),
        });
    const find = async (email: string, extra = '') =>
      (
        await alice
          .get(
            `/marketing/abandoned-carts?search=${encodeURIComponent(email)}${extra}`,
          )
          .expect(200)
      ).body.data[0];
    const backdate = (email: string, interval: string) =>
      t.db.asOwner((pg) =>
        pg.query(
          `update abandoned_carts set last_activity_at = now() - $2::interval where email = $1`,
          [email, interval],
        ),
      );
    const tokenOf = async (email: string) => {
      const row = await find(email);
      const detail = (
        await alice.get(`/marketing/abandoned-carts/${row.id}`).expect(200)
      ).body.data;
      return {
        id: row.id as string,
        detail,
        token:
          (detail.recoveryPath as string | null)?.split('recover=')[1] ?? '',
      };
    };

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      process.env.CRON_SECRET = CRON_SECRET;
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner(async (pg) => {
        const p = (
          tenant: string,
          name: string,
          slug: string,
          price: number,
          qty: number,
        ) =>
          pg.query(
            `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1,$2,$3,$4,$5,'active')`,
            [tenant, name, slug, price, qty],
          );
        await p(w.tenantA, 'Mug', 'ac-mug', 50000, 1000);
        await p(w.tenantA, 'Pen', 'ac-pen', 10000, 1000);
        await p(w.tenantA, 'Rare', 'ac-rare', 70000, 3);
        await p(w.tenantB, 'Beta mug', 'ac-beta', 50000, 1000);
      });
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      nobody = await as(t, w.members.nothing, w.tenantA);
      await alice
        .put('/payments/cod', { enabled: true, minOrderMinor: 0, feeMinor: 0 })
        .expect(200);
    });
    afterAll(async () => {
      delete process.env.CRON_SECRET;
      await t?.close();
      await t?.db.close();
    });

    describe('saving a cart from the storefront', () => {
      it('keeps the items priced by the server, never the browser', async () => {
        const email = 'priced@example.test';
        const res = await checkpoint({
          customer: { email },
          lines: [{ ...MUG, expectedUnitPriceMinor: 1 }],
        }).expect(200);
        expect(res.body.data).toEqual({ saved: true });
        const row = await find(email);
        expect(row).toMatchObject({
          status: 'active',
          cartValueMinor: 100000,
          itemCount: 1,
          marketingConsent: false,
          canContact: false,
          recoveryClicks: 0,
          currency: 'INR',
        });
      });

      it('validates the request and ignores nothing it does not know', async () => {
        await checkpoint({ cartKey: 'short' }).expect(400);
        await checkpoint({ cartKey: 'has spaces and !! symbols' }).expect(400);
        await checkpoint({ lines: [] }).expect(400);
        await checkpoint({ customer: { email: 'not-an-email' } }).expect(400);
        await checkpoint({ customer: {} }).expect(400);
        await checkpoint({ tenantId: w.tenantB }).expect(400);
        await checkpoint({}, 'ghost-store').expect(404);
      });

      it('refreshes one row per browser cart and starts another for a new one', async () => {
        const email = 'refresh@example.test';
        const cartKey = newKey();
        await checkpoint({ cartKey, customer: { email }, lines: [MUG] }).expect(
          200,
        );
        await backdate(email, '3 hours');
        expect((await find(email)).status).toBe('abandoned');
        // The shopper adds a pen and consents: the same row is live again with the new items.
        await checkpoint({
          cartKey,
          customer: { email, fullName: 'Asha R' },
          lines: [MUG, PEN],
          marketingConsent: true,
        }).expect(200);
        const rows = (
          await alice
            .get(`/marketing/abandoned-carts?search=${email}`)
            .expect(200)
        ).body.data;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'active',
          itemCount: 2,
          cartValueMinor: 110000,
          customerName: 'Asha R',
          marketingConsent: true,
          canContact: true,
        });
        await checkpoint({ customer: { email }, lines: [PEN] }).expect(200);
        expect(
          (
            await alice
              .get(`/marketing/abandoned-carts?search=${email}`)
              .expect(200)
          ).body.data,
        ).toHaveLength(2);
      });

      it('leaves out products that cannot be bought and saves nothing when none can', async () => {
        const email = 'mixed@example.test';
        await checkpoint({
          customer: { email },
          lines: [MUG, { productSlug: 'no-such-product', quantity: 1 }],
        }).expect(200);
        expect((await find(email)).itemCount).toBe(1);
        const none = await checkpoint({
          customer: { email: 'none@example.test' },
          lines: [{ productSlug: 'no-such-product', quantity: 1 }],
        }).expect(200);
        expect(none.body.data).toEqual({ saved: false });
        expect(await find('none@example.test')).toBeUndefined();
      });

      it('never stores the browser cart id or exposes any lookup hash', async () => {
        const cartKey = newKey();
        const email = 'private@example.test';
        await checkpoint({ cartKey, customer: { email } }).expect(200);
        const stored = await t.db.asOwner((pg) =>
          pg.query<{ cart_key_hash: string; recovery_token_hash: string }>(
            `select cart_key_hash, recovery_token_hash from abandoned_carts where email = $1`,
            [email],
          ),
        );
        expect(stored.rows[0].cart_key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(stored.rows)).not.toContain(cartKey);
        const { token, id, detail } = await tokenOf(email);
        expect(stored.rows[0].recovery_token_hash).not.toContain(token);
        const everything = JSON.stringify([
          await find(email),
          detail,
          (await alice.get('/marketing/abandoned-carts').expect(200)).body,
        ]);
        expect(everything).not.toContain(cartKey);
        expect(everything).not.toContain(stored.rows[0].cart_key_hash);
        expect(everything).not.toContain(stored.rows[0].recovery_token_hash);
        expect(id).toBeTruthy();
      });
    });

    describe('when a cart counts as abandoned', () => {
      it('follows the threshold and the recovery window', async () => {
        const email = 'timing@example.test';
        await checkpoint({ customer: { email } }).expect(200);
        expect((await find(email)).status).toBe('active');
        expect((await find(email)).abandonedAt).toBeNull();

        await backdate(email, '2 hours');
        const abandoned = await find(email);
        expect(abandoned.status).toBe('abandoned');
        // Abandoned from the moment it had been idle for the threshold: 60 minutes after its last activity.
        const gap =
          new Date(abandoned.abandonedAt).getTime() -
          new Date(abandoned.lastActivityAt).getTime();
        expect(gap).toBe(60 * 60_000);

        await backdate(email, '20 days');
        expect((await find(email)).status).toBe('expired');
      });

      it('uses the settings, and a changed threshold applies to carts already waiting', async () => {
        expect(
          (await alice.get('/marketing/abandoned-carts/settings').expect(200))
            .body.data,
        ).toMatchObject({
          configured: false,
          abandonmentThresholdMinutes: 60,
          recoveryLinkDays: 14,
        });
        const email = 'threshold@example.test';
        await checkpoint({ customer: { email } }).expect(200);
        await backdate(email, '30 minutes');
        expect((await find(email)).status).toBe('active');
        const saved = await alice
          .put('/marketing/abandoned-carts/settings', {
            abandonmentThresholdMinutes: 15,
            recoveryLinkDays: 7,
          })
          .expect(200);
        expect(saved.body.data).toMatchObject({
          configured: true,
          abandonmentThresholdMinutes: 15,
          recoveryLinkDays: 7,
        });
        expect((await find(email)).status).toBe('abandoned');
        await alice
          .put('/marketing/abandoned-carts/settings', {
            abandonmentThresholdMinutes: 60,
            recoveryLinkDays: 14,
          })
          .expect(200);
        expect((await find(email)).status).toBe('active');
      });

      it('validates the settings and keeps changing them to members who may', async () => {
        for (const bad of [
          { abandonmentThresholdMinutes: 14, recoveryLinkDays: 7 },
          { abandonmentThresholdMinutes: 10081, recoveryLinkDays: 7 },
          { abandonmentThresholdMinutes: 60, recoveryLinkDays: 0 },
          { abandonmentThresholdMinutes: 60, recoveryLinkDays: 91 },
          { abandonmentThresholdMinutes: 'soon', recoveryLinkDays: 7 },
          {
            abandonmentThresholdMinutes: 60,
            recoveryLinkDays: 7,
            tenantId: w.tenantB,
          },
        ])
          await alice
            .put('/marketing/abandoned-carts/settings', bad)
            .expect(400);
        await reader
          .put('/marketing/abandoned-carts/settings', {
            abandonmentThresholdMinutes: 30,
            recoveryLinkDays: 7,
          })
          .expect(403);
        await reader.get('/marketing/abandoned-carts/settings').expect(200);
        // The other store's settings are its own.
        expect(
          (await bob.get('/marketing/abandoned-carts/settings').expect(200))
            .body.data.configured,
        ).toBe(false);
      });
    });

    describe('recovery links', () => {
      it("rebuild the cart with today's prices and say what is no longer available", async () => {
        const email = 'recover@example.test';
        await checkpoint({
          customer: { email, fullName: 'Recover Me' },
          lines: [MUG, PEN, { productSlug: 'ac-rare', quantity: 2 }],
        }).expect(200);
        const { token, detail } = await tokenOf(email);
        expect(detail.recoveryPath).toBe(`/s/alpha-shop/cart?recover=${token}`);
        expect(token).toHaveLength(43);

        await t.db.asOwner(async (pg) => {
          await pg.query(
            `update products set price_minor = 55000 where slug = 'ac-mug'`,
          );
          await pg.query(
            `update products set quantity = 1 where slug = 'ac-rare'`,
          );
          await pg.query(
            `update products set status = 'draft' where slug = 'ac-pen'`,
          );
        });
        const res = await open(token).expect(200);
        expect(res.body.data).toMatchObject({
          email,
          customerName: 'Recover Me',
        });
        expect(res.body.data.lines).toEqual([
          expect.objectContaining({
            productSlug: 'ac-mug',
            quantity: 2,
            unitPriceMinor: 55000,
            priceChanged: true,
          }),
        ]);
        expect(
          res.body.data.issues.map((i: { code: string }) => i.code).sort(),
        ).toEqual(['OUT_OF_STOCK', 'PRODUCT_UNAVAILABLE']);
        await t.db.asOwner(async (pg) => {
          await pg.query(
            `update products set price_minor = 50000 where slug = 'ac-mug'`,
          );
          await pg.query(
            `update products set quantity = 3 where slug = 'ac-rare'`,
          );
          await pg.query(
            `update products set status = 'active' where slug = 'ac-pen'`,
          );
        });
        expect(
          (
            await alice
              .get(`/marketing/abandoned-carts/${detail.id}`)
              .expect(200)
          ).body.data.recoveryClicks,
        ).toBe(1);
      });

      it('answer the same 404 for wrong, foreign and malformed links', async () => {
        const { token } = await tokenOf('recover@example.test');
        const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
        for (const bad of [wrong, 'x', 'a'.repeat(43), `${token}extra`]) {
          const res = await open(bad).expect(404);
          expect(res.body.error.code).toBe('RECOVERY_LINK_INVALID');
        }
        // A real link of one store does not open in another store.
        expect(
          (await open(token, 'beta-shop').expect(404)).body.error.code,
        ).toBe('RECOVERY_LINK_INVALID');
      });

      it('stop working after the recovery window and once the cart is erased', async () => {
        const email = 'window@example.test';
        await checkpoint({ customer: { email } }).expect(200);
        const { token, id } = await tokenOf(email);
        await open(token).expect(200);
        await backdate(email, '15 days');
        await open(token).expect(404);
        const row = await find(email);
        expect(row.status).toBe('expired');
        expect(
          (await alice.get(`/marketing/abandoned-carts/${id}`).expect(200)).body
            .data.recoveryPath,
        ).toBeNull();

        await checkpoint({ customer: { email: 'erase@example.test' } }).expect(
          200,
        );
        const gone = await tokenOf('erase@example.test');
        await open(gone.token).expect(200);
        await alice.delete(`/marketing/abandoned-carts/${gone.id}`).expect(200);
        await open(gone.token).expect(404);
        await alice.get(`/marketing/abandoned-carts/${gone.id}`).expect(404);
      });
    });

    describe('when the shopper buys', () => {
      it('clears a cart that never counted as abandoned', async () => {
        const email = 'quick@example.test';
        const cartKey = newKey();
        await checkpoint({ cartKey, customer: { email }, lines: [PEN] }).expect(
          200,
        );
        expect(await find(email)).toBeDefined();
        await order(email, cartKey).expect(201);
        expect(await find(email)).toBeUndefined();
      });

      it('marks an abandoned cart recovered and links the order', async () => {
        const email = 'comeback@example.test';
        const cartKey = newKey();
        await checkpoint({ cartKey, customer: { email }, lines: [MUG] }).expect(
          200,
        );
        await backdate(email, '3 hours');
        const placed = (await order(email, cartKey, [MUG]).expect(201)).body
          .data;
        const row = await find(email);
        expect(row).toMatchObject({
          status: 'recovered',
          recoveredOrderNumber: placed.orderNumber,
        });
        expect(row.recoveredAt).toBeTruthy();
        expect(
          (await alice.get(`/marketing/abandoned-carts/${row.id}`).expect(200))
            .body.data.recoveryPath,
        ).toBeNull();
      });

      it('matches by email when the browser sent no cart id, and ignores other shoppers', async () => {
        const email = 'byemail@example.test';
        await checkpoint({ customer: { email } }).expect(200);
        await checkpoint({
          customer: { email: 'bystander@example.test' },
        }).expect(200);
        await backdate(email, '3 hours');
        await backdate('bystander@example.test', '3 hours');
        await order(email).expect(201);
        expect((await find(email)).status).toBe('recovered');
        expect((await find('bystander@example.test')).status).toBe('abandoned');
      });

      it('lets a recovered shopper start a new cart under the same id', async () => {
        const email = 'again@example.test';
        const cartKey = newKey();
        await checkpoint({ cartKey, customer: { email } }).expect(200);
        await backdate(email, '3 hours');
        await order(email, cartKey).expect(201);
        expect((await find(email)).status).toBe('recovered');
        await checkpoint({ cartKey, customer: { email } }).expect(200);
        expect(await find(email)).toMatchObject({
          status: 'active',
          recoveredAt: null,
        });
      });

      it('never lets cart tracking stop an order, even without the server key', async () => {
        const saved = Object.fromEntries(
          KEY_ENV.map((k) => [k, process.env[k]]),
        );
        try {
          for (const k of KEY_ENV) delete process.env[k];
          const res = await checkpoint({
            customer: { email: 'nokey@example.test' },
          }).expect(503);
          expect(res.body.error.code).toBe('CART_RECOVERY_UNAVAILABLE');
          await order('nokey@example.test', newKey()).expect(201);
        } finally {
          for (const k of KEY_ENV) process.env[k] = saved[k];
        }
      });
    });

    describe('how long saved carts are kept', () => {
      const insert = (
        tenant: string,
        email: string,
        daysIdle: number,
        status = 'active',
        recoveredDaysAgo?: number,
      ) =>
        t.db.asOwner((pg) =>
          pg.query(
            `insert into abandoned_carts (tenant_id, cart_key_hash, recovery_token_hash, email, items, item_count, cart_value_minor, currency,
               status, last_activity_at, recovered_at)
             values ($1, $2, $3, $4, '[{"productId":"x"}]'::jsonb, 1, 100, 'INR', $5, now() - ($6 || ' days')::interval,
               case when $5 = 'recovered' then now() - ($7 || ' days')::interval end)`,
            [
              tenant,
              `k-${email}`,
              `r-${email}`,
              email,
              status,
              String(daysIdle),
              String(recoveredDaysAgo ?? 0),
            ],
          ),
        );
      const left = async () =>
        (
          await t.db.asOwner((pg) =>
            pg.query<{ email: string }>(
              `select email from abandoned_carts order by email`,
            ),
          )
        ).rows.map((r) => r.email);
      const job = () => anon().get(api('/internal/jobs/purge-abandoned-carts'));

      it('refuses the scheduler call without the right secret', async () => {
        await job().expect(401);
        await job()
          .set('Authorization', 'Bearer wrong-secret-wrong-secret-wrong-secret')
          .expect(401);
      });

      it('deletes carts past their retention, in every store, and keeps the rest', async () => {
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
        await insert(w.tenantA, 'fresh@x.test', 1);
        await insert(w.tenantA, 'abandoned-recently@x.test', 40); // link lifetime 14 + 30 = 44 days: kept
        await insert(w.tenantA, 'stale@x.test', 60); // gone
        await insert(w.tenantB, 'stale-in-b@x.test', 90); // gone, whichever store it is in
        await insert(
          w.tenantA,
          'recovered-recently@x.test',
          100,
          'recovered',
          100,
        ); // kept (under 180 days)
        await insert(
          w.tenantA,
          'recovered-long-ago@x.test',
          300,
          'recovered',
          200,
        ); // gone
        const res = await job()
          .set('Authorization', `Bearer ${CRON_SECRET}`)
          .expect(200);
        expect(res.body.data).toEqual({ deleted: 3, complete: true });
        expect(await left()).toEqual([
          'abandoned-recently@x.test',
          'fresh@x.test',
          'recovered-recently@x.test',
        ]);
        // Nothing left to do the second time.
        expect(
          (
            await job()
              .set('Authorization', `Bearer ${CRON_SECRET}`)
              .expect(200)
          ).body.data,
        ).toEqual({ deleted: 0, complete: true });
      });

      it('follows the link lifetime each store chose', async () => {
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
        await alice
          .put('/marketing/abandoned-carts/settings', {
            abandonmentThresholdMinutes: 60,
            recoveryLinkDays: 90,
          })
          .expect(200);
        await insert(w.tenantA, 'long-link@x.test', 100); // 90 + 30 = 120 days: kept
        await insert(w.tenantA, 'longer@x.test', 130); // gone
        await job().set('Authorization', `Bearer ${CRON_SECRET}`).expect(200);
        expect(await left()).toEqual(['long-link@x.test']);
        await alice
          .put('/marketing/abandoned-carts/settings', {
            abandonmentThresholdMinutes: 60,
            recoveryLinkDays: 14,
          })
          .expect(200);
      });

      it('works through a large backlog in batches and says when it stopped early', async () => {
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
        for (let i = 0; i < 5; i += 1)
          await insert(w.tenantA, `old${i}@x.test`, 200);
        const service = t.app.get(CartRecoveryService);
        expect(await service.purgeStale(2, 2)).toEqual({
          deleted: 4,
          complete: false,
        });
        expect(await service.purgeStale(2, 2)).toEqual({
          deleted: 1,
          complete: true,
        });
        expect(await left()).toEqual([]);
      });

      it('is not reachable by a signed-in user or a shopper', async () => {
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
        await insert(w.tenantA, 'safe@x.test', 200);
        await expect(
          t.db.service.withUser(w.alice, (tx) =>
            tx.execute(sql`select public.purge_stale_abandoned_carts(10)`),
          ),
        ).rejects.toThrow();
        expect(await left()).toEqual(['safe@x.test']);
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
      });
    });

    describe('the dashboard', () => {
      it('summarizes abandoned, recovered and the recovery rate', async () => {
        await t.db.asOwner((pg) => pg.query(`delete from abandoned_carts`));
        const make = async (
          email: string,
          hoursIdle: number,
          lines: object[],
        ) => {
          await checkpoint({ customer: { email }, lines }).expect(200);
          await backdate(email, `${hoursIdle} hours`);
        };
        await make('s1@example.test', 3, [MUG]); // abandoned, 100000
        await make('s2@example.test', 3, [PEN]); // abandoned, 10000
        await make('s3@example.test', 3, [MUG]); // will come back
        await make('s4@example.test', 0, [PEN]); // still shopping
        await order('s3@example.test', undefined, [
          { ...MUG, quantity: 1 },
        ]).expect(201);
        const s = (
          await alice.get('/marketing/abandoned-carts/summary').expect(200)
        ).body.data;
        expect(s).toMatchObject({
          abandonedCount: 2,
          abandonedValueMinor: 110000,
          recoveredCount: 1,
          recoveredValueMinor: 50000,
          recoveryRatePercent: 33.3,
          activeCount: 1,
        });
        await alice
          .get('/marketing/abandoned-carts/summary?from=2026-02-30')
          .expect(400);
      });

      it('lists, filters, sorts and pages', async () => {
        const abandoned = (
          await alice
            .get(
              '/marketing/abandoned-carts?status=abandoned&sortBy=cartValue&sortOrder=desc',
            )
            .expect(200)
        ).body;
        expect(abandoned.data.map((c: { email: string }) => c.email)).toEqual([
          's1@example.test',
          's2@example.test',
        ]);
        expect(abandoned.meta.total).toBe(2);
        const page = (
          await alice
            .get(
              '/marketing/abandoned-carts?limit=1&page=2&sortBy=cartValue&sortOrder=desc',
            )
            .expect(200)
        ).body;
        expect(page.data).toHaveLength(1);
        expect(page.meta.total).toBeGreaterThan(2);
        const none = (
          await alice
            .get('/marketing/abandoned-carts?from=2020-01-01&to=2020-01-31')
            .expect(200)
        ).body;
        expect(none.data).toEqual([]);
        await alice
          .get('/marketing/abandoned-carts?status=nonsense')
          .expect(400);
        await alice.get('/marketing/abandoned-carts?to=nope').expect(400);
      });

      it("needs the right access and keeps each store's carts private", async () => {
        await anon().get(api('/marketing/abandoned-carts')).expect(401);
        await nobody.get('/marketing/abandoned-carts').expect(403);
        await reader.get('/marketing/abandoned-carts').expect(200);
        const mine = (
          await alice.get('/marketing/abandoned-carts?search=s1@').expect(200)
        ).body.data[0];
        await reader
          .delete(`/marketing/abandoned-carts/${mine.id}`)
          .expect(403);
        // Another store sees none of it, and cannot read or erase it by id.
        expect(
          (await bob.get('/marketing/abandoned-carts').expect(200)).body.data,
        ).toEqual([]);
        await bob.get(`/marketing/abandoned-carts/${mine.id}`).expect(404);
        await bob.delete(`/marketing/abandoned-carts/${mine.id}`).expect(404);
        expect(
          (await alice.get(`/marketing/abandoned-carts/${mine.id}`).expect(200))
            .body.data.email,
        ).toBe('s1@example.test');
        await (
          await as(t, w.alice, w.tenantB)
        )
          .get('/marketing/abandoned-carts')
          .expect(403);
      });

      it('sends nothing: no mail or SMS provider exists to call', async () => {
        const row = (
          await alice.get('/marketing/abandoned-carts?search=s1@').expect(200)
        ).body.data[0];
        // Contact needs consent and an email; even then this API only reports it.
        expect(row).toMatchObject({
          marketingConsent: false,
          canContact: false,
        });
      });
    });
  },
);
