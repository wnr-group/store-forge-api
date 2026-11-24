import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { createPlatformAdmin } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)('platform RBAC (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let owner: Client;
  let billingId: string;
  let supportId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    billingId = await createPlatformAdmin(
      db,
      'billing@example.test',
      'billing_admin',
    );
    supportId = await createPlatformAdmin(
      db,
      'support@example.test',
      'support_admin',
    );
    t = await createTestApp(db);
    sup = await as(t, w.superAdmin);
    admin = await as(t, w.admin);
    billing = await as(t, billingId);
    support = await as(t, supportId);
    owner = await as(t, w.alice);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  it('reports each role and its permissions from the database', async () => {
    const b = (await billing.get('/platform/me').expect(200)).body.data;
    expect(b.level).toBe('billing_admin');
    expect(b.permissions).toContain('billing:manage');
    expect(b.permissions).not.toContain('tenants:manage');
    const s = (await support.get('/platform/me').expect(200)).body.data;
    expect(s.level).toBe('support_admin');
    expect(s.permissions).not.toContain('billing:read');
  });

  it('reports the same role from /auth/me as from /platform/me, for every platform role, and none to a tenant Owner', async () => {
    for (const [c, level] of [
      [sup, 'super_admin'],
      [admin, 'admin'],
      [billing, 'billing_admin'],
      [support, 'support_admin'],
    ] as const) {
      const me = (await c.get('/auth/me').expect(200)).body.data;
      const platform = (await c.get('/platform/me').expect(200)).body.data;
      expect(me.platformAdminLevel).toBe(level);
      expect(me.platformAdminLevel).toBe(platform.level);
    }
    expect(
      (await owner.get('/auth/me').expect(200)).body.data.platformAdminLevel,
    ).toBeNull();
    await owner.get('/platform/me').expect(403);
  });

  it('lets Billing and Support admins read what their role includes', async () => {
    for (const c of [billing, support]) {
      await c.get('/platform/organizations').expect(200);
      await c.get(`/platform/organizations/${w.tenantA}`).expect(200);
      await c.get('/platform/overview').expect(200);
      await c.get('/platform/usage/summary').expect(200);
      await c.get('/platform/settings').expect(200);
    }
  });

  it('keeps Billing and Support admins out of everything else', async () => {
    for (const c of [billing, support]) {
      const audit = await c.get('/platform/audit-logs').expect(403);
      expect(audit.body.error.code).toBe('PLATFORM_PERMISSION_REQUIRED');
      await c.get('/platform/admins').expect(403);
      await c
        .patch(`/platform/organizations/${w.tenantA}/status`, {
          status: 'suspended',
        })
        .expect(403);
      await c.delete(`/platform/organizations/${w.tenantA}`).expect(403);
      await c
        .patch('/platform/settings', { platformName: 'Hijacked' })
        .expect(403);
      await c
        .post('/platform/admins', {
          fullName: 'Self Promoted',
          email: 'x@example.test',
          password: 'Passw0rd-1',
          role: 'super_admin',
        })
        .expect(403);
      await c
        .patch(`/platform/admins/${c === billing ? billingId : supportId}`, {
          role: 'super_admin',
        })
        .expect(403);
    }
  });

  it('keeps the Platform Admin able to read the audit log but not to manage admins', async () => {
    await admin.get('/platform/audit-logs').expect(200);
    const res = await admin
      .patch(`/platform/admins/${billingId}`, { role: 'super_admin' })
      .expect(403);
    expect(res.body.error.code).toBe('SUPER_ADMIN_REQUIRED');
  });

  it('refuses a tenant Owner on every platform route', async () => {
    await owner.get('/platform/me').expect(403);
    await owner.get('/platform/organizations').expect(403);
    await owner.get('/platform/audit-logs').expect(403);
    await owner
      .post('/platform/admins', {
        fullName: 'Owner Promoted',
        email: 'y@example.test',
        password: 'Passw0rd-1',
        role: 'super_admin',
      })
      .expect(403);
  });

  it('lets only a super admin assign the new roles, and audits the change', async () => {
    await sup
      .post('/platform/admins', {
        fullName: 'Fiona Billing',
        email: 'fiona@example.test',
        password: 'Passw0rd-1',
        role: 'billing_admin',
      })
      .expect(201);
    const list = (await sup.get('/platform/admins').expect(200)).body.data;
    const fiona = list.find(
      (a: { email: string }) => a.email === 'fiona@example.test',
    );
    expect(fiona.role).toBe('billing_admin');

    await sup
      .patch(`/platform/admins/${fiona.userId}`, { role: 'support_admin' })
      .expect(200);
    await sup
      .patch(`/platform/admins/${fiona.userId}`, { role: 'owner' })
      .expect(400);

    const audit = (await sup.get('/platform/audit-logs').expect(200)).body.data;
    expect(
      audit.some(
        (e: { action: string }) => e.action === 'platform_admin.role_changed',
      ),
    ).toBe(true);
  });

  it('never lets the last super admin be demoted into a narrower role', async () => {
    const res = await sup
      .patch(`/platform/admins/${w.superAdmin}`, { role: 'billing_admin' })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    expect(res.status).not.toBe(200);
    expect((await sup.get('/platform/me').expect(200)).body.data.level).toBe(
      'super_admin',
    );
  });
});
