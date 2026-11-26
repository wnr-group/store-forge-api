import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  asUser,
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)('subscription plans (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let alice: Client;
  let legacyId: string;
  let starterId: string;
  let growthId: string;

  const planBody = (over: Record<string, unknown> = {}) => ({
    code: 'starter',
    name: 'Starter',
    description: 'For small stores',
    monthlyPrice: '499',
    yearlyPrice: '4990',
    trialDays: 14,
    features: { discount_codes: true, google_analytics: false },
    limits: { products: { soft: 80, hard: 100 }, staff_accounts: { hard: 2 } },
    ...over,
  });

  const audit = async (query: string) =>
    (await sup.get(`/platform/audit-logs?${query}`).expect(200)).body.data as {
      action: string;
      previousData: Record<string, unknown> | null;
      newData: Record<string, unknown> | null;
    }[];

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
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  describe('catalog and the seeded Legacy plan', () => {
    it('lists the features and limits a plan can use', async () => {
      const c = (await admin.get('/platform/plan-catalog').expect(200)).body
        .data;
      expect(c.features.map((f: { key: string }) => f.key)).toContain(
        'google_analytics',
      );
      expect(c.limits.map((l: { key: string }) => l.key)).toEqual([
        'products',
        'staff_accounts',
        'orders_per_month',
        'storage_bytes',
      ]);
    });

    it('starts with an unrestricted default plan that every existing tenant is on', async () => {
      const list = (await admin.get('/platform/plans').expect(200)).body.data;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        code: 'legacy',
        isDefault: true,
        isUnrestricted: true,
        status: 'active',
        subscriberCount: 2,
      });
      legacyId = list[0].id;
      for (const tenant of [w.tenantA, w.tenantB]) {
        const s = (
          await admin
            .get(`/platform/organizations/${tenant}/subscription`)
            .expect(200)
        ).body.data;
        expect(s).toMatchObject({
          plan: { code: 'legacy' },
          status: 'active',
          billingInterval: 'monthly',
          currentPeriodEnd: null,
        });
      }
    });
  });

  describe('creating and reading plans', () => {
    it('creates a plan with prices, trial, features and limits, and logs it', async () => {
      const res = await admin.post('/platform/plans', planBody()).expect(201);
      const p = res.body.data;
      starterId = p.id;
      expect(p).toMatchObject({
        code: 'starter',
        name: 'Starter',
        status: 'active',
        currency: 'INR',
        monthlyPrice: '499.00',
        monthlyPriceMinor: 49900,
        yearlyPriceMinor: 499000,
        trialDays: 14,
        isDefault: false,
        isUnrestricted: false,
        subscriberCount: 0,
      });
      // Every catalog key is present, switched off / unlimited unless set.
      expect(p.features.discount_codes).toBe(true);
      expect(p.features.google_analytics).toBe(false);
      expect(p.features.meta_pixel).toBe(false);
      expect(p.limits.products).toEqual({ soft: 80, hard: 100 });
      expect(p.limits.staff_accounts).toEqual({ soft: null, hard: 2 });
      expect(p.limits.storage_bytes).toEqual({ soft: null, hard: null });

      const entries = await audit('action=plan.created');
      expect(entries).toHaveLength(1);
      expect(entries[0].newData).toMatchObject({ code: 'starter' });
    });

    it('lists, filters, searches and fetches plans', async () => {
      await admin
        .post(
          '/platform/plans',
          planBody({
            code: 'growth',
            name: 'Growth',
            monthlyPrice: '1499.50',
            yearlyPrice: '14995',
            trialDays: 0,
            features: {
              discount_codes: true,
              google_analytics: true,
              meta_pixel: true,
            },
            limits: { products: { hard: 1000 } },
          }),
        )
        .expect(201)
        .then((r) => (growthId = r.body.data.id));
      const all = (await admin.get('/platform/plans').expect(200)).body;
      expect(all.meta.total).toBe(3);
      expect(all.data.map((p: { code: string }) => p.code)).toEqual(
        expect.arrayContaining(['legacy', 'starter', 'growth']),
      );
      const found = (await admin.get('/platform/plans?search=grow').expect(200))
        .body.data;
      expect(found.map((p: { code: string }) => p.code)).toEqual(['growth']);
      expect(
        (await admin.get('/platform/plans?search=%25').expect(200)).body.data,
      ).toHaveLength(0);
      expect(
        (await admin.get(`/platform/plans/${growthId}`).expect(200)).body.data
          .monthlyPrice,
      ).toBe('1499.50');
      await admin
        .get('/platform/plans/00000000-0000-4000-8000-000000000009')
        .expect(404);
    });

    it('refuses bad input and a duplicate code', async () => {
      const dup = await admin.post('/platform/plans', planBody()).expect(409);
      expect(dup.body.error.code).toBe('PLAN_CODE_TAKEN');
      for (const bad of [
        { code: 'X' },
        { name: '' },
        { monthlyPrice: '-5' },
        { monthlyPrice: 'abc' },
        { monthlyPrice: '10.555' },
        { trialDays: 400 },
        { features: { time_travel: true } },
        { features: { discount_codes: 'yes' } },
        { limits: { products: { soft: 10, hard: 5 } } },
        { limits: { products: { soft: -1 } } },
        { limits: { teleports: { hard: 1 } } },
        { limits: { products: { hard: 1.5 } } },
      ]) {
        await admin
          .post('/platform/plans', planBody({ code: 'other-plan', ...bad }))
          .expect(400);
      }
      expect(
        (await admin.get('/platform/plans').expect(200)).body.meta.total,
      ).toBe(3);
    });
  });

  describe('editing plans', () => {
    it('changes only what is sent, and logs only what changed', async () => {
      const res = await admin
        .patch(`/platform/plans/${starterId}`, {
          monthlyPrice: '599',
          features: { meta_pixel: true },
          limits: { products: { soft: 150, hard: 200 }, staff_accounts: null },
        })
        .expect(200);
      const p = res.body.data;
      expect(p).toMatchObject({
        name: 'Starter',
        monthlyPriceMinor: 59900,
        yearlyPriceMinor: 499000,
      });
      expect(p.features).toMatchObject({
        discount_codes: true,
        meta_pixel: true,
      });
      expect(p.limits.products).toEqual({ soft: 150, hard: 200 });
      expect(p.limits.staff_accounts).toEqual({ soft: null, hard: null });

      const [entry] = await audit('action=plan.updated');
      expect(Object.keys(entry.newData ?? {}).sort()).toEqual(
        ['code', 'features', 'limits', 'monthlyPrice'].sort(),
      );
      expect(entry.previousData).toMatchObject({ monthlyPrice: '499.00' });
    });

    it('does nothing, and logs nothing, when nothing differs', async () => {
      const before = (await audit('action=plan.updated')).length;
      await admin
        .patch(`/platform/plans/${starterId}`, {
          name: 'Starter',
          monthlyPrice: '599.00',
          features: { meta_pixel: true },
        })
        .expect(200);
      expect((await audit('action=plan.updated')).length).toBe(before);
    });

    it('refuses limits where soft is above hard after merging with the sent values', async () => {
      await admin
        .patch(`/platform/plans/${starterId}`, {
          limits: { products: { soft: 300, hard: 200 } },
        })
        .expect(400);
    });

    it('manages the default plan: one at a time, always one, active only', async () => {
      await admin
        .patch(`/platform/plans/${legacyId}`, { isDefault: false })
        .expect(400)
        .then((r) => expect(r.body.error.code).toBe('PLAN_IS_DEFAULT'));
      await admin
        .patch(`/platform/plans/${legacyId}/status`, { status: 'inactive' })
        .expect(400);

      await admin
        .patch(`/platform/plans/${growthId}/status`, { status: 'inactive' })
        .expect(200);
      await admin
        .patch(`/platform/plans/${growthId}`, { isDefault: true })
        .expect(400)
        .then((r) => expect(r.body.error.code).toBe('PLAN_INACTIVE'));
      await admin
        .patch(`/platform/plans/${growthId}/status`, { status: 'active' })
        .expect(200);

      await admin
        .patch(`/platform/plans/${starterId}`, { isDefault: true })
        .expect(200);
      const list = (await admin.get('/platform/plans').expect(200)).body.data;
      expect(
        list
          .filter((p: { isDefault: boolean }) => p.isDefault)
          .map((p: { code: string }) => p.code),
      ).toEqual(['starter']);
      expect(await audit('action=plan.default_changed')).toHaveLength(1);
      // Put Legacy back as the default for the remaining tests.
      await admin
        .patch(`/platform/plans/${legacyId}`, { isDefault: true })
        .expect(200);
    });

    it('logs activation and deactivation', async () => {
      expect((await audit('action=plan.deactivated')).length).toBe(1);
      expect((await audit('action=plan.activated')).length).toBe(1);
    });
  });

  describe('subscriptions', () => {
    it('moves an organization to a plan with a trial, and keeps the trial from restarting', async () => {
      const res = await admin
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: starterId,
          billingInterval: 'monthly',
          startTrial: true,
        })
        .expect(200);
      const s = res.body.data;
      expect(s).toMatchObject({
        plan: { code: 'starter' },
        status: 'trialing',
        billingInterval: 'monthly',
      });
      const days =
        (new Date(s.trialEndsAt).getTime() -
          new Date(s.currentPeriodStart).getTime()) /
        86_400_000;
      expect(Math.round(days)).toBe(14);
      expect(s.currentPeriodEnd).toBe(s.trialEndsAt);

      // Same plan and interval again: unchanged, not logged.
      const count = (await audit('action=subscription.changed')).length;
      const again = await admin
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: starterId,
        })
        .expect(200);
      expect(again.body.data.id).toBe(s.id);
      expect(again.body.data.updatedAt).toBe(s.updatedAt);
      expect((await audit('action=subscription.changed')).length).toBe(count);
    });

    it('upgrades to a paid yearly plan without a new trial and sets the renewal date', async () => {
      const s = (
        await admin
          .put(`/platform/organizations/${w.tenantA}/subscription`, {
            planId: growthId,
            billingInterval: 'yearly',
          })
          .expect(200)
      ).body.data;
      expect(s).toMatchObject({
        plan: { code: 'growth' },
        status: 'active',
        trialEndsAt: null,
      });
      const years =
        (new Date(s.currentPeriodEnd).getTime() -
          new Date(s.currentPeriodStart).getTime()) /
        86_400_000;
      expect(Math.round(years)).toBeGreaterThanOrEqual(365);
      const [change] = await audit(
        `action=subscription.changed&org=${w.tenantA}`,
      );
      expect(change.previousData).toMatchObject({ planCode: 'starter' });
      expect(change.newData).toMatchObject({
        planCode: 'growth',
        billingInterval: 'yearly',
      });
    });

    it('downgrades back to the free Legacy plan with no renewal date', async () => {
      const s = (
        await admin
          .put(`/platform/organizations/${w.tenantA}/subscription`, {
            planId: legacyId,
          })
          .expect(200)
      ).body.data;
      expect(s).toMatchObject({
        plan: { code: 'legacy' },
        status: 'active',
        currentPeriodEnd: null,
      });
    });

    it('refuses an inactive, unknown or malformed plan and an unknown organization', async () => {
      await admin
        .patch(`/platform/plans/${growthId}/status`, { status: 'inactive' })
        .expect(200);
      const r = await admin
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: growthId,
        })
        .expect(400);
      expect(r.body.error.code).toBe('PLAN_INACTIVE');
      await admin
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: '00000000-0000-4000-8000-000000000009',
        })
        .expect(404);
      await admin
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: 'nope',
        })
        .expect(400);
      await admin
        .put(
          '/platform/organizations/00000000-0000-4000-8000-000000000009/subscription',
          {
            planId: starterId,
          },
        )
        .expect(404);
      // Organizations already on an inactive plan keep it.
      await admin
        .patch(`/platform/plans/${growthId}/status`, { status: 'active' })
        .expect(200);
    });

    it('gives a new organization the default plan, or the plan the admin chose, atomically', async () => {
      const make = (slug: string, extra: Record<string, unknown> = {}) =>
        admin.post('/platform/organizations', {
          companyName: `${slug} Co`,
          storeName: slug,
          storeSlug: slug,
          ownerName: 'Owner',
          ownerEmail: `${slug}@example.test`,
          ownerPassword: 'Passw0rd-1',
          ...extra,
        });
      const plain = (await make('plain-shop').expect(201)).body.data;
      expect(
        (
          await admin
            .get(`/platform/organizations/${plain.tenantId}/subscription`)
            .expect(200)
        ).body.data.plan.code,
      ).toBe('legacy');

      const chosen = (
        await make('chosen-shop', { planId: starterId }).expect(201)
      ).body.data;
      const sub = (
        await admin
          .get(`/platform/organizations/${chosen.tenantId}/subscription`)
          .expect(200)
      ).body.data;
      expect(sub).toMatchObject({
        plan: { code: 'starter' },
        status: 'trialing',
      });
      const created = await audit(
        `action=subscription.created&org=${chosen.tenantId}`,
      );
      expect(created).toHaveLength(1);
      expect(created[0].newData).toMatchObject({ planCode: 'starter' });

      // An unusable plan rolls the whole creation back: no tenant is left behind.
      const bad = await make('rolled-back', {
        planId: '00000000-0000-4000-8000-000000000009',
      });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      const left = await t.db.asOwner((pg) =>
        pg.query(
          "select count(*)::int as n from tenants where slug = 'rolled-back'",
        ),
      );
      expect(left.rows[0]).toEqual({ n: 0 });
    });
  });

  describe('who can do what', () => {
    it('lets Billing read plans and subscriptions but not change them; Support reads subscriptions only', async () => {
      await billing.get('/platform/plans').expect(200);
      await billing.get('/platform/plan-catalog').expect(200);
      await billing
        .get(`/platform/organizations/${w.tenantA}/subscription`)
        .expect(200);
      await billing
        .post('/platform/plans', planBody({ code: 'sneaky' }))
        .expect(403);
      await billing
        .patch(`/platform/plans/${starterId}`, { name: 'Hacked' })
        .expect(403);
      await billing
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: starterId,
        })
        .expect(403);

      await support
        .get(`/platform/organizations/${w.tenantA}/subscription`)
        .expect(200);
      await support.get('/platform/plans').expect(403);
      await support
        .patch(`/platform/plans/${starterId}/status`, { status: 'inactive' })
        .expect(403);
      await support
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: starterId,
        })
        .expect(403);
    });

    it('keeps plans and subscriptions away from tenant users, at the API and in the database', async () => {
      await alice.get('/platform/plans').expect(403);
      await alice
        .get(`/platform/organizations/${w.tenantA}/subscription`)
        .expect(403);
      await alice
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: legacyId,
        })
        .expect(403);

      // Even a direct query as the tenant Owner sees nothing, and cannot write.
      const seen = await asUser(t.db, w.alice, async (tx) => ({
        plans: rowsOf<{ n: number }>(
          await tx.execute(sql`select count(*)::int as n from public.plans`),
        )[0].n,
        subs: rowsOf<{ n: number }>(
          await tx.execute(
            sql`select count(*)::int as n from public.tenant_subscriptions`,
          ),
        )[0].n,
      }));
      expect(seen).toEqual({ plans: 0, subs: 0 });
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`update public.tenant_subscriptions set plan_id = plan_id`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`select public.platform_assign_plan(${w.tenantA}::uuid, ${legacyId}::uuid, 'monthly', false)`,
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
