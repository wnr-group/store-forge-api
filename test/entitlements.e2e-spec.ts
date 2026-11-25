import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURE_KEYS } from '../src/common/constants/plan-catalog.js';
import { rowsOf } from '../src/database/database.service.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import {
  asUser,
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)(
  'plan entitlements and limits (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let sup: Client;
    let admin: Client;
    let billing: Client;
    let support: Client;
    let alice: Client; // owner of tenant A
    let aliceH: Client; // same, with the explicit organization header some routes require
    let bob: Client; // owner of tenant B
    let bobH: Client; // same, with the explicit organization header some routes require
    let legacyId: string;
    let basicId: string;
    let proId: string;

    const audit = async (query: string) =>
      (await sup.get(`/platform/audit-logs?${query}`).expect(200)).body
        .data as {
        action: string;
        previousData: Record<string, unknown> | null;
        newData: Record<string, unknown> | null;
      }[];
    const moveTo = (tenant: string, planId: string) =>
      sup
        .put(`/platform/organizations/${tenant}/subscription`, { planId })
        .expect(200);
    const mine = async (c: Client) =>
      (await c.get('/entitlements').expect(200)).body.data;
    const limit = (e: { limits: { key: string }[] }, key: string) =>
      e.limits.find((l) => l.key === key) as unknown as {
        used: number;
        soft: number | null;
        hard: number | null;
        percent: number | null;
        level: string;
      };
    const setSub = (tenant: string, set: string) =>
      t.db.asOwner((pg) =>
        pg.query(
          `update tenant_subscriptions set ${set} where tenant_id = $1`,
          [tenant],
        ),
      );
    const FULL = {
      products: 'write',
      orders: 'read',
      customers: 'write',
      settings: 'write',
    };
    const product = (c: Client, name: string) =>
      c.post('/products', { name, price: '10' });

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
      t = await createTestApp(db);
      sup = await as(t, w.superAdmin);
      admin = await as(t, w.admin);
      billing = await as(t, billingId);
      support = await as(t, supportId);
      alice = await as(t, w.alice);
      aliceH = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob);
      bobH = await as(t, w.bob, w.tenantB);

      legacyId = (await admin.get('/platform/plans').expect(200)).body.data[0]
        .id;
      basicId = (
        await admin
          .post('/platform/plans', {
            code: 'basic',
            name: 'Basic',
            monthlyPrice: '0',
            yearlyPrice: '0',
            features: { multiple_staff: true },
            limits: {
              products: { soft: 1, hard: 2 },
              staff_accounts: { hard: 1 },
              orders_per_month: { hard: 0 },
            },
          })
          .expect(201)
      ).body.data.id;
      proId = (
        await admin
          .post('/platform/plans', {
            code: 'pro',
            name: 'Pro',
            monthlyPrice: '999',
            yearlyPrice: '9990',
            features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
          })
          .expect(201)
      ).body.data.id;
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('what a tenant sees about itself', () => {
      it('an existing tenant on the Legacy plan has every feature and no limits', async () => {
        const e = await mine(alice);
        expect(e).toMatchObject({
          planCode: 'legacy',
          isUnrestricted: true,
          entitled: true,
        });
        expect(e.features.every((f: { enabled: boolean }) => f.enabled)).toBe(
          true,
        );
        expect(
          e.limits.every((l: { hard: number | null }) => l.hard === null),
        ).toBe(true);
        expect(e.attention).toEqual([]);
      });

      it('shows a limited plan with usage, percent and level', async () => {
        await moveTo(w.tenantA, basicId);
        const e = await mine(alice);
        expect(e.planCode).toBe('basic');
        expect(
          e.features.find((f: { key: string }) => f.key === 'discount_codes')
            .enabled,
        ).toBe(false);
        expect(
          e.features.find((f: { key: string }) => f.key === 'multiple_staff')
            .enabled,
        ).toBe(true);
        expect(limit(e, 'products')).toMatchObject({
          used: 0,
          soft: 1,
          hard: 2,
          percent: 0,
          level: 'ok',
        });
      });

      it('only answers for the tenant the caller belongs to', async () => {
        await bob.get('/entitlements').expect(200); // B's own, from the header-less default
        const asBobOnA = await as(t, w.bob, w.tenantA);
        expect(
          (await asBobOnA.get('/entitlements')).status,
        ).toBeGreaterThanOrEqual(400);
        await expect(
          asUser(t.db, w.bob, (tx) =>
            tx.execute(
              sql`select public.tenant_entitlements(${w.tenantA}::uuid)`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, w.bob, (tx) =>
            tx.execute(
              sql`select public.tenant_usage_counts(${w.tenantA}::uuid)`,
            ),
          ),
        ).rejects.toThrow();
      });
    });

    describe('hard limits are enforced by the API', () => {
      const ids: string[] = [];

      it('allows products up to the hard limit, warning on the way', async () => {
        ids.push((await product(alice, 'One').expect(201)).body.data.id);
        let e = await mine(alice);
        expect(limit(e, 'products')).toMatchObject({
          used: 1,
          percent: 50,
          level: 'warning',
        });
        expect(e.attention.map((l: { key: string }) => l.key)).toContain(
          'products',
        );

        ids.push((await product(alice, 'Two').expect(201)).body.data.id);
        e = await mine(alice);
        expect(limit(e, 'products')).toMatchObject({
          used: 2,
          percent: 100,
          level: 'reached',
        });
      });

      it('refuses the next product with the numbers, however it is added', async () => {
        const res = await product(alice, 'Three').expect(403);
        expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
        expect(res.body.error.details).toEqual({
          limit: 'products',
          used: 2,
          hard: 2,
        });
        await alice.post(`/products/${ids[0]}/duplicate`).expect(403);
        const count = await t.db.asOwner((pg) =>
          pg.query(
            'select count(*)::int as n from products where tenant_id = $1',
            [w.tenantA],
          ),
        );
        expect(count.rows[0]).toEqual({ n: 2 });
      });

      it('lets goes on once something is removed, and never lets simultaneous requests exceed the limit', async () => {
        await alice.delete(`/products/${ids[1]}`).expect(200);
        const results = await Promise.all(
          ['A', 'B', 'C', 'D', 'E'].map((n) => product(alice, `Race ${n}`)),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(results.filter((r) => r.status === 403)).toHaveLength(4);
        const count = await t.db.asOwner((pg) =>
          pg.query(
            'select count(*)::int as n from products where tenant_id = $1',
            [w.tenantA],
          ),
        );
        expect(count.rows[0]).toEqual({ n: 2 });
      });

      it('a per-organization limit replaces the plan limit, and clearing it brings the plan back', async () => {
        await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/limits/products`,
            { hard: 3 },
          )
          .expect(200);
        await product(alice, 'Allowed by exception').expect(201);
        await product(alice, 'Over the exception').expect(403);
        const unlimited = await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/limits/products`,
            {},
          )
          .expect(200);
        expect(
          unlimited.body.data.limits.find(
            (l: { key: string }) => l.key === 'products',
          ),
        ).toMatchObject({
          hard: null,
          source: 'override',
        });
        await product(alice, 'Unlimited for this tenant').expect(201);
        await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/limits/products`,
            { clear: true },
          )
          .expect(200);
        await product(alice, 'Back to the plan').expect(403);
      });

      it('only reports the orders limit, because it never turns a shopper away', async () => {
        const e = await mine(alice);
        expect(limit(e, 'orders_per_month')).toMatchObject({
          hard: 0,
          level: 'reached',
        });
        expect(
          e.limits.find((l: { key: string }) => l.key === 'orders_per_month')
            .enforced,
        ).toBe(false);
      });

      it('limits staff accounts, and removes the account again when the limit refuses it', async () => {
        await moveTo(w.tenantB, basicId);
        const add = (email: string) =>
          bobH.post('/team/members', {
            fullName: 'Staff Person',
            email,
            password: 'Passw0rd-1',
            permissions: FULL,
          });
        await add('first@staff.test').expect(201);
        const refused = await add('second@staff.test').expect(403);
        expect(refused.body.error.code).toBe('PLAN_LIMIT_REACHED');
        expect(refused.body.error.details).toMatchObject({
          limit: 'staff_accounts',
          used: 1,
          hard: 1,
        });
        expect(t.authAdmin.deleted.length).toBeGreaterThan(0);
        const staff = await t.db.asOwner((pg) =>
          pg.query(
            "select count(*)::int as n from memberships where tenant_id = $1 and role <> 'owner'",
            [w.tenantB],
          ),
        );
        expect(staff.rows[0]).toEqual({ n: 1 });
      });

      it('refuses everything new while the subscription is not active, and treats an ended trial the same', async () => {
        await setSub(w.tenantA, "status = 'expired'");
        const res = await product(alice, 'Blocked').expect(403);
        expect(res.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
        expect(await mine(alice)).toMatchObject({
          entitled: false,
          subscriptionStatus: 'expired',
        });
        await setSub(
          w.tenantA,
          "status = 'trialing', trial_ends_at = now() - interval '1 day'",
        );
        expect(await mine(alice)).toMatchObject({
          entitled: false,
          subscriptionStatus: 'expired',
        });
        await setSub(w.tenantA, "status = 'active', trial_ends_at = null");
        expect((await mine(alice)).entitled).toBe(true);
      });
    });

    describe('features are enforced by the API', () => {
      it('refuses the routes of features the plan does not include', async () => {
        for (const res of [
          await alice.get('/marketing/discounts'),
          await alice.get('/marketing/campaigns'),
          await alice.get('/marketing/abandoned-carts'),
          await alice.get('/analytics/sales'),
          await aliceH.put('/integrations/ga4', {
            config: { measurementId: 'G-ABCDEFGHIJ' },
          }),
          await aliceH.post('/integrations/meta_pixel/enable'),
          await aliceH.put('/shipping/carriers/shiprocket', {}),
          await aliceH.put('/payments/razorpay', {}),
        ]) {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('FEATURE_NOT_AVAILABLE');
        }
        // The basic dashboard analytics and reading integrations are not gated.
        await alice
          .get('/analytics/overview')
          .then((r) => expect(r.status).not.toBe(403));
        await aliceH.get('/integrations').expect(200);
      });

      it('team creation needs the staff feature as well as room under the limit', async () => {
        await bobH
          .post('/team/members', {
            fullName: 'No Staff',
            email: 'nostaff@staff.test',
            password: 'Passw0rd-1',
            permissions: FULL,
          })
          .expect(403)
          .then((r) => expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED'));
        await sup
          .put(
            `/platform/organizations/${w.tenantB}/entitlements/features/multiple_staff`,
            { enabled: false },
          )
          .expect(200);
        await bobH
          .post('/team/members', {
            fullName: 'No Staff',
            email: 'nostaff@staff.test',
            password: 'Passw0rd-1',
            permissions: FULL,
          })
          .expect(403)
          .then((r) => expect(r.body.error.code).toBe('FEATURE_NOT_AVAILABLE'));
        await sup
          .put(
            `/platform/organizations/${w.tenantB}/entitlements/features/multiple_staff`,
            { enabled: null },
          )
          .expect(200);
      });

      it('an exception for one organization opens a feature, and removing it closes it again', async () => {
        await alice.get('/marketing/discounts').expect(403);
        const res = await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/features/discount_codes`,
            {
              enabled: true,
              note: 'Pilot customer',
            },
          )
          .expect(200);
        expect(res.body.data.featureOverrides).toMatchObject([
          { key: 'discount_codes', enabled: true, note: 'Pilot customer' },
        ]);
        expect(
          res.body.data.features.find(
            (f: { key: string }) => f.key === 'discount_codes',
          ),
        ).toMatchObject({
          enabled: true,
          source: 'override',
        });
        await alice.get('/marketing/discounts').expect(200);
        // Other organizations are unaffected.
        await bob.get('/marketing/discounts').expect(403);
        await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/features/discount_codes`,
            { enabled: null },
          )
          .expect(200);
        await alice.get('/marketing/discounts').expect(403);
      });

      it('moving to a plan with the features switches them on straight away, and back switches them off', async () => {
        await moveTo(w.tenantA, proId);
        await alice.get('/marketing/discounts').expect(200);
        await alice.get('/marketing/campaigns').expect(200);
        await moveTo(w.tenantA, basicId);
        await alice.get('/marketing/discounts').expect(403);
      });

      it('editing the plan changes what its organizations may use, with no other step', async () => {
        await admin
          .patch(`/platform/plans/${basicId}`, {
            features: { discount_codes: true },
          })
          .expect(200);
        await alice.get('/marketing/discounts').expect(200);
        await admin
          .patch(`/platform/plans/${basicId}`, {
            features: { discount_codes: false },
          })
          .expect(200);
        await alice.get('/marketing/discounts').expect(403);
      });

      it('stops serving a tracking integration the plan no longer includes, without anyone switching it off', async () => {
        await moveTo(w.tenantB, legacyId);
        await bobH
          .put('/integrations/ga4', {
            config: { measurementId: 'G-ABCDEFGHIJ' },
          })
          .expect(200);
        await bobH.post('/integrations/ga4/enable').expect(200);
        const tracking = () =>
          anonymous(t).get('/public/stores/beta-shop/tracking');
        expect(
          (await tracking().expect(200)).body.data.providers.map(
            (p: { provider: string }) => p.provider,
          ),
        ).toEqual(['ga4']);

        await moveTo(w.tenantB, basicId);
        expect((await tracking().expect(200)).body.data.providers).toEqual([]);
        await bobH.post('/integrations/ga4/disable').expect(200); // switching off is always allowed
        await bobH.post('/integrations/ga4/enable').expect(403);

        await sup
          .put(
            `/platform/organizations/${w.tenantB}/entitlements/features/google_analytics`,
            { enabled: true },
          )
          .expect(200);
        await bobH.post('/integrations/ga4/enable').expect(200);
        expect((await tracking().expect(200)).body.data.providers).toHaveLength(
          1,
        );
      });
    });

    describe('the SQL rule and the API rule agree', () => {
      it('gives the same answer for every feature in every scenario', async () => {
        const scenarios: [string, () => Promise<unknown>][] = [
          ['unrestricted plan', () => moveTo(w.tenantA, legacyId)],
          ['limited plan', () => moveTo(w.tenantA, basicId)],
          ['all-features plan', () => moveTo(w.tenantA, proId)],
          [
            'exception off on a plan that has it',
            () =>
              sup.put(
                `/platform/organizations/${w.tenantA}/entitlements/features/meta_pixel`,
                { enabled: false },
              ),
          ],
          [
            'exception on on a plan without it',
            async () => {
              await moveTo(w.tenantA, basicId);
              await sup.put(
                `/platform/organizations/${w.tenantA}/entitlements/features/advanced_reports`,
                { enabled: true },
              );
            },
          ],
          [
            'expired subscription',
            () => setSub(w.tenantA, "status = 'expired'"),
          ],
        ];
        for (const [name, apply] of scenarios) {
          await apply();
          const e = await mine(alice);
          for (const key of FEATURE_KEYS) {
            const db = await t.db.asOwner((pg) =>
              pg.query<{ ok: boolean }>(
                'select public.tenant_has_feature($1, $2) as ok',
                [w.tenantA, key],
              ),
            );
            const api = e.features.find(
              (f: { key: string }) => f.key === key,
            ).enabled;
            expect(db.rows[0].ok, `${name}: ${key}`).toBe(api);
          }
        }
        await setSub(w.tenantA, "status = 'active'");
      });
    });

    describe('platform administration', () => {
      it('logs exceptions with before and after, and nothing when nothing changes', async () => {
        const removedBefore = (
          await audit('action=entitlement.feature_override_removed')
        ).length;
        const before = (await audit('action=entitlement.feature_overridden'))
          .length;
        const put = (enabled: boolean | null) =>
          sup.put(
            `/platform/organizations/${w.tenantB}/entitlements/features/shipping_integrations`,
            { enabled },
          );
        await put(true).expect(200);
        await put(true).expect(200);
        const entries = await audit('action=entitlement.feature_overridden');
        expect(entries.length).toBe(before + 1);
        expect(entries[0].newData).toMatchObject({
          feature: 'shipping_integrations',
          enabled: true,
        });
        await put(false).expect(200);
        expect(
          (await audit('action=entitlement.feature_overridden'))[0]
            .previousData,
        ).toMatchObject({ enabled: true });
        await put(null).expect(200);
        await put(null).expect(200);
        expect(
          (await audit('action=entitlement.feature_override_removed')).length,
        ).toBe(removedBefore + 1);
      });

      it('refuses unknown keys, bad numbers and a soft limit above the hard limit', async () => {
        const base = `/platform/organizations/${w.tenantA}/entitlements`;
        await sup
          .put(`${base}/features/time_travel`, { enabled: true })
          .expect(400);
        await sup
          .put(`${base}/features/discount_codes`, { enabled: 'yes' })
          .expect(400);
        await sup.put(`${base}/features/discount_codes`, {}).expect(400);
        await sup.put(`${base}/limits/teleports`, { hard: 1 }).expect(400);
        await sup.put(`${base}/limits/products`, { hard: -1 }).expect(400);
        await sup
          .put(`${base}/limits/products`, { soft: 10, hard: 5 })
          .expect(400);
        await sup.put(`${base}/limits/products`, { hard: 1.5 }).expect(400);
        await sup
          .put(
            '/platform/organizations/00000000-0000-4000-8000-000000000009/entitlements/limits/products',
            { hard: 1 },
          )
          .expect(404);
        await sup
          .get(
            '/platform/organizations/00000000-0000-4000-8000-000000000009/entitlements',
          )
          .expect(404);
      });

      it('reports organizations close to their limits, with usage and percentages', async () => {
        await sup
          .put(
            `/platform/organizations/${w.tenantA}/entitlements/limits/products`,
            { clear: true },
          )
          .expect(200);
        const attention = (await admin.get('/platform/limit-usage').expect(200))
          .body;
        const row = attention.data.find(
          (r: { id: string }) => r.id === w.tenantA,
        );
        expect(row).toMatchObject({ planCode: 'basic', worstLevel: 'reached' });
        expect(
          row.limits.find((l: { key: string }) => l.key === 'products'),
        ).toMatchObject({
          used: 4,
          hard: 2,
          percent: 200,
          level: 'reached',
        });
        const reached = (
          await admin.get('/platform/limit-usage?filter=reached').expect(200)
        ).body.data;
        expect(reached.map((r: { id: string }) => r.id)).toContain(w.tenantA);
        const all = (
          await admin.get('/platform/limit-usage?filter=all').expect(200)
        ).body;
        expect(all.meta.total).toBe(2);
        expect(
          (
            await admin
              .get(
                `/platform/limit-usage?filter=all&search=${encodeURIComponent('beta')}`,
              )
              .expect(200)
          ).body.data,
        ).toHaveLength(1);
        await admin.get('/platform/limit-usage?filter=nonsense').expect(400);
        await moveTo(w.tenantA, legacyId);
        const ok = (
          await admin.get('/platform/limit-usage?filter=attention').expect(200)
        ).body.data;
        expect(ok.map((r: { id: string }) => r.id)).not.toContain(w.tenantA);
      });

      it('shows one organization with storage, exceptions and warnings', async () => {
        await moveTo(w.tenantA, basicId);
        const e = (
          await admin
            .get(`/platform/organizations/${w.tenantA}/entitlements`)
            .expect(200)
        ).body.data;
        expect(e.planCode).toBe('basic');
        expect(e.limits.map((l: { key: string }) => l.key)).toContain(
          'storage_bytes',
        );
        expect(e.attention.length).toBeGreaterThan(0);
      });

      it('lets Support and Billing look but not change, and keeps tenant users out', async () => {
        const path = `/platform/organizations/${w.tenantA}/entitlements`;
        await support.get(path).expect(200);
        await billing.get(path).expect(200);
        await support.get('/platform/limit-usage').expect(200);
        for (const c of [support, billing, alice]) {
          await c
            .put(`${path}/features/discount_codes`, { enabled: true })
            .expect(403);
          await c.put(`${path}/limits/products`, { hard: 999 }).expect(403);
        }
        await alice.get(path).expect(403);
        await alice.get('/platform/limit-usage').expect(403);
        await alice.get('/marketing/discounts').expect(403); // unchanged by any of that
      });

      it('keeps the override tables unreachable by tenant users', async () => {
        const n = await asUser(
          t.db,
          w.alice,
          async (tx) =>
            rowsOf<{ a: number; b: number }>(
              await tx.execute(
                sql`select (select count(*) from public.tenant_feature_overrides)::int as a, (select count(*) from public.tenant_limit_overrides)::int as b`,
              ),
            )[0],
        );
        expect(n).toEqual({ a: 0, b: 0 });
        await expect(
          asUser(t.db, w.alice, (tx) =>
            tx.execute(
              sql`insert into public.tenant_feature_overrides (tenant_id, feature_key, enabled) values (${w.tenantA}::uuid, 'discount_codes', true)`,
            ),
          ),
        ).rejects.toThrow();
      });
    });
  },
);
