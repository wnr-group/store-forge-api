import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)('platform dashboard (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let alice: Client;
  let paidId: string;

  const dashboard = async (c: Client, query = '') =>
    (await c.get(`/platform/dashboard${query}`).expect(200)).body.data;

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
    paidId = (
      await admin
        .post('/platform/plans', {
          code: 'paid',
          name: 'Paid',
          monthlyPrice: '500',
          yearlyPrice: '5000',
          trialDays: 14,
        })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  it('counts organizations, people and subscriptions from the real records', async () => {
    const d = await dashboard(admin);
    expect(d.tenants).toMatchObject({ total: 2, active: 2, suspended: 0 });
    expect(d.tenants.users).toBeGreaterThanOrEqual(2);
    expect(d.subscriptions).toEqual({
      active: 2,
      trialing: 0,
      pastDue: 0,
      expired: 0,
      canceled: 0,
    });
    expect(d.health).toEqual({ api: 'up', database: 'up' });
  });

  it('follows changes: a trial, a suspension, an expired trial and an expired subscription', async () => {
    await sup
      .put(`/platform/organizations/${w.tenantA}/subscription`, {
        planId: paidId,
        startTrial: true,
      })
      .expect(200);
    expect((await dashboard(admin)).subscriptions).toMatchObject({
      active: 1,
      trialing: 1,
    });

    await sup
      .patch(`/platform/organizations/${w.tenantB}/status`, {
        status: 'suspended',
      })
      .expect(200);
    expect((await dashboard(admin)).tenants).toMatchObject({
      total: 2,
      active: 1,
      suspended: 1,
    });

    await t.db.asOwner((pg) =>
      pg.query(
        "update tenant_subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
        [w.tenantA],
      ),
    );
    expect((await dashboard(admin)).subscriptions).toMatchObject({
      trialing: 0,
      expired: 1,
    });
    await t.db.asOwner((pg) =>
      pg.query(
        "update tenant_subscriptions set status = 'expired' where tenant_id = $1",
        [w.tenantB],
      ),
    );
    expect((await dashboard(admin)).subscriptions).toMatchObject({
      active: 0,
      expired: 2,
    });
  });

  it('shows growth over the range with zeros where nothing happened', async () => {
    const d = await dashboard(admin, '?from=2026-01-01&to=2026-01-10');
    expect(d.growth.bucket).toBe('day');
    expect(d.growth.newOrganizations).toHaveLength(10);
    expect(
      d.growth.newSubscriptions.every((p: { count: number }) => p.count === 0),
    ).toBe(true);
    const wide = await dashboard(admin);
    const total = wide.growth.newOrganizations.reduce(
      (a: number, p: { count: number }) => a + p.count,
      0,
    );
    expect(total).toBe(2);
    expect(
      wide.growth.newSubscriptions.reduce(
        (a: number, p: { count: number }) => a + p.count,
        0,
      ),
    ).toBe(2);
    await admin.get('/platform/dashboard?from=yesterday').expect(400);
  });

  it('includes revenue and recent activity only for the roles that may read them', async () => {
    const full = await dashboard(admin);
    expect(full.billing).toMatchObject({
      successfulPayments: 0,
      failedPayments: 0,
      mrr: [],
    });
    expect(full.recentActivity.length).toBeGreaterThan(0);
    expect(full.recentActivity[0]).toHaveProperty('action');

    const bill = await dashboard(billing);
    expect(bill.billing).not.toBeNull();
    expect(bill.recentActivity).toBeNull();

    const sup2 = await dashboard(support);
    expect(sup2.billing).toBeNull();
    expect(sup2.recentActivity).toBeNull();
    expect(sup2.tenants.total).toBe(2);
  });

  it('is closed to tenant users and to anyone not signed in', async () => {
    await alice.get('/platform/dashboard').expect(403);
    const res = await (await as(t, w.carol)).get('/platform/dashboard');
    expect(res.status).toBe(403);
  });
});
