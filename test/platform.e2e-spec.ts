import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const FULL = {
  products: 'write',
  orders: 'read',
  customers: 'write',
  settings: 'write',
};

describe.skipIf(!migrationsAvailable)('platform administration (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Awaited<ReturnType<typeof as>>; // super admin
  let admin: Awaited<ReturnType<typeof as>>; // regular admin
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    sup = await as(t, w.superAdmin);
    admin = await as(t, w.admin);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const createOrg = (
    client: typeof sup,
    overrides: Record<string, unknown> = {},
  ) =>
    client.post('/platform/organizations', {
      companyName: 'Gamma Trading',
      storeName: 'Gamma Store',
      storeSlug: 'gamma-store',
      storeDescription: 'Things',
      contactPhone: '+44 20 7946 0958',
      address: '1 High Street',
      ownerName: 'Gina Owner',
      ownerEmail: 'Gina@Gamma.test',
      ownerPassword: 'Passw0rd-1',
      ...overrides,
    });

  describe('who am I', () => {
    it('reports the level from the database', async () => {
      expect((await sup.get('/platform/me').expect(200)).body.data.level).toBe(
        'super_admin',
      );
      expect(
        (await admin.get('/platform/me').expect(200)).body.data.level,
      ).toBe('admin');
    });
  });

  describe('organizations', () => {
    it('creates an organization with its confirmed owner, store and an audit entry', async () => {
      const res = await createOrg(admin).expect(201);
      expect(res.body.data).toMatchObject({ ownerEmail: 'gina@gamma.test' });
      orgId = res.body.data.tenantId;
      ownerId = res.body.data.ownerId;

      const detail = (
        await admin.get(`/platform/organizations/${orgId}`).expect(200)
      ).body.data;
      expect(detail.company).toMatchObject({
        name: 'Gamma Trading',
        slug: 'gamma-store',
        status: 'active',
        ownerEmail: 'gina@gamma.test',
        memberCount: 1,
      });
      expect(detail.store).toMatchObject({
        slug: 'gamma-store',
        currency: 'INR',
        hasMoneyData: false,
      });
      expect(detail.team).toHaveLength(1);
      expect(detail.team[0]).toMatchObject({
        role: 'owner',
        roleLabel: 'Owner',
      });

      // The owner can sign in to their organization straight away, and nobody else sees it.
      const owner = await as(t, ownerId);
      expect(
        (await owner.get('/organizations/current').expect(200)).body.data
          .organization.id,
      ).toBe(orgId);
      await (await as(t, w.alice, orgId)).get('/products').expect(403);

      const audit = (
        await admin.get(`/platform/audit-logs?org=${orgId}`).expect(200)
      ).body.data;
      // The organization and its starting subscription (default plan) are logged together.
      expect(audit.map((e: { action: string }) => e.action).sort()).toEqual([
        'organization.created',
        'subscription.created',
      ]);
      expect(
        audit.find(
          (e: { action: string }) => e.action === 'organization.created',
        ),
      ).toMatchObject({
        adminEmail: 'admin@example.test',
        organizationName: 'Gamma Trading',
      });
      expect(JSON.stringify(audit)).not.toContain('Passw0rd-1'); // passwords are never logged
    });

    it('refuses a taken, reserved or malformed store address, and creates no account for it', async () => {
      const before = (
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from auth.users'),
        )
      ).rows[0] as { n: number };
      const taken = await createOrg(admin, {
        storeSlug: 'alpha-shop',
        ownerEmail: 'x1@example.test',
      }).expect(409);
      expect(taken.body.error.code).toBe('STORE_SLUG_TAKEN');
      await createOrg(admin, {
        storeSlug: 'admin',
        ownerEmail: 'x2@example.test',
      }).expect(400);
      await createOrg(admin, {
        storeSlug: 'A',
        ownerEmail: 'x3@example.test',
      }).expect(400);
      const after = (
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from auth.users'),
        )
      ).rows[0] as { n: number };
      expect(after.n).toBe(before.n);
    });

    it('rolls the account back when provisioning fails after the account was created', async () => {
      // An owner e-mail that already exists as an org member is fine for Auth (new email) but a duplicate slug race is not
      // reproducible here; instead make Auth itself fail and check nothing is left behind.
      t.authAdmin.failNextCreate = true;
      await createOrg(admin, {
        storeSlug: 'delta-store',
        ownerEmail: 'delta@example.test',
      }).expect(500);
      const exists = await t.db.asOwner((pg) =>
        pg.query("select 1 from auth.users where email = 'delta@example.test'"),
      );
      expect(exists.rows).toHaveLength(0);
      const list = (
        await admin.get('/platform/organizations?search=delta').expect(200)
      ).body;
      expect(list.meta.total).toBe(0);
    });

    it('refuses an e-mail that already has an account', async () => {
      const res = await createOrg(admin, {
        storeSlug: 'dup-store',
        ownerEmail: 'alice@example.test',
      }).expect(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('lists with search, status filter, sorting and clamps a page past the end', async () => {
      const all = await admin
        .get('/platform/organizations?sortBy=name&sortOrder=asc')
        .expect(200);
      expect(all.body.data.map((o: { slug: string }) => o.slug)).toEqual([
        'alpha-shop',
        'beta-shop',
        'gamma-store',
      ]);
      expect(all.body.meta).toMatchObject({ total: 3, page: 1 });
      const search = await admin
        .get('/platform/organizations?search=gamma')
        .expect(200);
      expect(search.body.data).toHaveLength(1);
      const past = await admin
        .get('/platform/organizations?page=99&limit=2')
        .expect(200);
      expect(past.body.meta.page).toBe(2);
      expect(past.body.data).toHaveLength(1);
      await admin.get('/platform/organizations?status=weird').expect(400);
    });

    it('edits name, phone and address (partial) and logs only what changed', async () => {
      const res = await admin
        .patch(`/platform/organizations/${orgId}`, {
          companyName: 'Gamma Trading Ltd',
          address: null,
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        name: 'Gamma Trading Ltd',
        address: null,
        contactPhone: '+44 20 7946 0958',
      });
      const log = (
        await admin
          .get(`/platform/audit-logs?org=${orgId}&action=organization.updated`)
          .expect(200)
      ).body.data;
      expect(log).toHaveLength(1);
      expect(log[0].previousData).toEqual({
        name: 'Gamma Trading',
        address: '1 High Street',
      });
      expect(log[0].newData).toEqual({
        name: 'Gamma Trading Ltd',
        address: null,
      });
      // Nothing changed: no write, no log entry.
      await admin
        .patch(`/platform/organizations/${orgId}`, {
          companyName: 'Gamma Trading Ltd',
        })
        .expect(200);
      expect(
        (
          await admin
            .get(
              `/platform/audit-logs?org=${orgId}&action=organization.updated`,
            )
            .expect(200)
        ).body.meta.total,
      ).toBe(1);
    });

    it('edits the store but locks the currency once there is money data', async () => {
      const ok = await admin
        .patch(`/platform/organizations/${orgId}/store`, {
          name: 'Gamma Shop',
          currency: 'GBP',
          timezone: 'Europe/London',
        })
        .expect(200);
      expect(ok.body.data).toMatchObject({
        name: 'Gamma Shop',
        currency: 'GBP',
        timezone: 'Europe/London',
        slug: 'gamma-store',
      });
      const owner = await as(t, ownerId);
      await owner
        .post('/products', { name: 'Gamma Item', price: '5.00' })
        .expect(201);
      const locked = await admin
        .patch(`/platform/organizations/${orgId}/store`, { currency: 'EUR' })
        .expect(400);
      expect(locked.body.error.code).toBe('CURRENCY_LOCKED');
      await admin
        .patch(`/platform/organizations/${orgId}/store`, { slug: 'sneaky' })
        .expect(400); // the address is not editable here
    });

    it("a platform store edit leaves the owner's SEO metadata alone, and cannot set it", async () => {
      const owner = await as(t, ownerId);
      await owner
        .patch('/store', {
          metaTitle: 'Gamma | Official shop',
          metaDescription: 'The Gamma shop.',
        })
        .expect(200);
      // Edits that touch other fields, and one that clears an optional field, must not reach the SEO columns.
      await admin
        .patch(`/platform/organizations/${orgId}/store`, {
          description: 'Edited by support',
          timezone: 'Europe/Paris',
        })
        .expect(200);
      await admin
        .patch(`/platform/organizations/${orgId}/store`, { description: null })
        .expect(200);
      const after = (await owner.get('/store').expect(200)).body.data;
      expect(after).toMatchObject({
        description: null,
        timezone: 'Europe/Paris',
        metaTitle: 'Gamma | Official shop',
        metaDescription: 'The Gamma shop.',
      });
      // The admin endpoint does not accept the fields at all.
      await admin
        .patch(`/platform/organizations/${orgId}/store`, { metaTitle: 'x' })
        .expect(400);
    });

    it('suspending hides the organization from its members; reactivating restores it', async () => {
      const owner = await as(t, ownerId);
      await admin
        .patch(`/platform/organizations/${orgId}/status`, {
          status: 'suspended',
        })
        .expect(200);
      await owner.get('/products').expect(404);
      expect(
        (
          await admin
            .get('/platform/organizations?status=suspended')
            .expect(200)
        ).body.meta.total,
      ).toBe(1);
      await admin
        .patch(`/platform/organizations/${orgId}/status`, { status: 'active' })
        .expect(200);
      await owner.get('/products').expect(200);
      await admin
        .patch(`/platform/organizations/${orgId}/status`, { status: 'deleted' })
        .expect(400);
      await admin
        .patch(`/platform/organizations/${randomUUID()}/status`, {
          status: 'suspended',
        })
        .expect(404);
      const log = (
        await admin.get(`/platform/audit-logs?org=${orgId}`).expect(200)
      ).body.data.map((l: { action: string }) => l.action);
      expect(log).toEqual(
        expect.arrayContaining([
          'organization.suspended',
          'organization.reactivated',
        ]),
      );
    });

    it('overview counts organizations and users', async () => {
      const res = await admin.get('/platform/overview').expect(200);
      expect(res.body.data).toMatchObject({
        totalOrganizations: 3,
        active: 3,
        suspended: 0,
      });
      expect(res.body.data.recent).toHaveLength(3);
    });
  });

  describe('team members and ownership', () => {
    let hire: string;

    it('adds a member (confirmed account + membership + audit) to any organization', async () => {
      const res = await admin
        .post(`/platform/organizations/${orgId}/members`, {
          fullName: 'Gamma Hire',
          email: 'hire@gamma.test',
          password: 'Passw0rd-1',
          permissions: FULL,
        })
        .expect(201);
      hire = res.body.data.userId;
      expect(
        (await admin.get(`/platform/organizations/${orgId}`).expect(200)).body
          .data.team,
      ).toHaveLength(2);
      const log = (
        await admin
          .get(`/platform/audit-logs?action=team_member.added&org=${orgId}`)
          .expect(200)
      ).body.data;
      expect(log[0].description).toContain('hire@gamma.test');
      expect(JSON.stringify(log)).not.toContain('Passw0rd-1');
    });

    it('cleans up the account when the membership cannot be created (unknown organization)', async () => {
      const before = t.authAdmin.deleted.length;
      await admin
        .post(`/platform/organizations/${randomUUID()}/members`, {
          fullName: 'Ghost',
          email: 'ghost@example.test',
          password: 'Passw0rd-1',
          permissions: FULL,
        })
        .expect(404);
      expect(t.authAdmin.deleted.length).toBe(before + 1);
      const exists = await t.db.asOwner((pg) =>
        pg.query("select 1 from auth.users where email = 'ghost@example.test'"),
      );
      expect(exists.rows).toHaveLength(0);
    });

    it('disables and reactivates a member, but never the owner', async () => {
      await admin
        .patch(`/platform/organizations/${orgId}/members/${hire}/status`, {
          status: 'disabled',
        })
        .expect(200);
      await (await as(t, hire, orgId)).get('/products').expect(404);
      await admin
        .patch(`/platform/organizations/${orgId}/members/${hire}/status`, {
          status: 'active',
        })
        .expect(200);
      const owner = await admin
        .patch(`/platform/organizations/${orgId}/members/${ownerId}/status`, {
          status: 'disabled',
        })
        .expect(400);
      expect(owner.body.error.code).toBe('OWNER_PROTECTED');
    });

    it('refuses to transfer ownership to the owner, a stranger or a disabled member', async () => {
      const same = await admin
        .post(`/platform/organizations/${orgId}/ownership/transfer`, {
          userId: ownerId,
        })
        .expect(400);
      expect(same.body.error.code).toBe('ALREADY_OWNER');
      await admin
        .post(`/platform/organizations/${orgId}/ownership/transfer`, {
          userId: w.bob,
        })
        .expect(404); // not a member here
      await admin
        .patch(`/platform/organizations/${orgId}/members/${hire}/status`, {
          status: 'disabled',
        })
        .expect(200);
      const disabled = await admin
        .post(`/platform/organizations/${orgId}/ownership/transfer`, {
          userId: hire,
        })
        .expect(400);
      expect(disabled.body.error.code).toBe('OWNER_NOT_ELIGIBLE');
      await admin
        .patch(`/platform/organizations/${orgId}/members/${hire}/status`, {
          status: 'active',
        })
        .expect(200);
    });

    it('transfers ownership atomically: exactly one owner, the old one kept as a member', async () => {
      await admin
        .post(`/platform/organizations/${orgId}/ownership/transfer`, {
          userId: hire,
          previousOwner: 'keep',
        })
        .expect(200);
      const team = (
        await admin.get(`/platform/organizations/${orgId}`).expect(200)
      ).body.data.team;
      expect(
        team.filter((m: { role: string }) => m.role === 'owner'),
      ).toHaveLength(1);
      expect(team.find((m: { userId: string }) => m.userId === hire).role).toBe(
        'owner',
      );
      const old = team.find((m: { userId: string }) => m.userId === ownerId);
      expect(old).toMatchObject({ role: 'admin', status: 'active' });
      // The new owner can now manage the team; the old one cannot.
      await (await as(t, hire, orgId)).get('/team/members').expect(200);
      await (await as(t, ownerId, orgId)).get('/team/members').expect(403);
      const log = (
        await admin
          .get(`/platform/audit-logs?action=ownership.transferred`)
          .expect(200)
      ).body.data;
      expect(log[0].description).toContain('Transferred ownership');
    });

    it('recovers ownership with a brand-new account, optionally disabling the previous owner', async () => {
      const res = await admin
        .post(`/platform/organizations/${orgId}/ownership/recover`, {
          ownerName: 'Rita Recovery',
          ownerEmail: 'rita@gamma.test',
          ownerPassword: 'Passw0rd-1',
          previousOwner: 'disable',
        })
        .expect(201);
      expect(res.body.data.email).toBe('rita@gamma.test');
      const team = (
        await admin.get(`/platform/organizations/${orgId}`).expect(200)
      ).body.data.team;
      expect(
        team.filter((m: { role: string }) => m.role === 'owner'),
      ).toHaveLength(1);
      expect(
        team.find((m: { userId: string }) => m.userId === hire),
      ).toMatchObject({ role: 'admin', status: 'disabled' });
      expect(
        team.find((m: { email: string }) => m.email === 'rita@gamma.test').role,
      ).toBe('owner');
    });

    it('removes a member and deletes their account when they belong nowhere else', async () => {
      await admin
        .delete(`/platform/organizations/${orgId}/members/${hire}`)
        .expect(200);
      expect(t.authAdmin.deleted).toContain(hire);
      await admin
        .delete(`/platform/organizations/${orgId}/members/${hire}`)
        .expect(404);
      const team = (
        await admin.get(`/platform/organizations/${orgId}`).expect(200)
      ).body.data.team;
      const owner = team.find((m: { role: string }) => m.role === 'owner');
      const res = await admin
        .delete(`/platform/organizations/${orgId}/members/${owner.userId}`)
        .expect(400);
      expect(res.body.error.code).toBe('OWNER_PROTECTED');
    });
  });

  describe('platform admins (super admin only)', () => {
    let added: string;

    it('a regular admin can list admins but not change them', async () => {
      expect(
        (await admin.get('/platform/admins').expect(200)).body.data,
      ).toHaveLength(2);
      const res = await admin
        .post('/platform/admins', {
          fullName: 'New Admin',
          email: 'newadmin@example.test',
          password: 'Passw0rd-1',
          role: 'admin',
        })
        .expect(403);
      expect(res.body.error.code).toBe('SUPER_ADMIN_REQUIRED');
      await admin
        .patch(`/platform/admins/${w.admin}`, { role: 'super_admin' })
        .expect(403); // no self-promotion
      await admin.delete(`/platform/admins/${w.superAdmin}`).expect(403);
    });

    it('a super admin adds, changes and removes admins', async () => {
      const res = await sup
        .post('/platform/admins', {
          fullName: 'New Admin',
          email: 'newadmin@example.test',
          password: 'Passw0rd-1',
          role: 'admin',
        })
        .expect(201);
      expect(res.body.data.email).toBe('newadmin@example.test');
      const list = (await sup.get('/platform/admins').expect(200)).body.data;
      added = list.find(
        (a: { email: string }) => a.email === 'newadmin@example.test',
      ).userId;
      expect(
        await (
          await as(t, added)
        )
          .get('/platform/me')
          .then((r) => r.body.data.level),
      ).toBe('admin');
      await sup
        .patch(`/platform/admins/${added}`, { role: 'super_admin' })
        .expect(200);
      expect(
        await (
          await as(t, added)
        )
          .get('/platform/me')
          .then((r) => r.body.data.level),
      ).toBe('super_admin');
      await sup
        .patch(`/platform/admins/${added}`, { role: 'admin' })
        .expect(200);
      await sup.delete(`/platform/admins/${added}`).expect(200);
      expect(t.authAdmin.deleted).toContain(added);
      await (await as(t, added)).get('/platform/me').expect(403);
    });

    it('an account that belongs to an organization cannot become a platform admin', async () => {
      const res = await sup.post('/platform/admins', {
        fullName: 'Alice Again',
        email: 'alice@example.test',
        password: 'Passw0rd-1',
        role: 'admin',
      });
      expect([400, 409]).toContain(res.status); // the e-mail already exists
    });

    it('the last super admin can never be removed or demoted', async () => {
      const demote = await sup
        .patch(`/platform/admins/${w.superAdmin}`, { role: 'admin' })
        .expect(400);
      expect(demote.body.error.code).toBe('LAST_SUPER_ADMIN');
      const remove = await sup
        .delete(`/platform/admins/${w.superAdmin}`)
        .expect(400);
      expect(remove.body.error.code).toBe('LAST_SUPER_ADMIN');
      expect((await sup.get('/platform/me').expect(200)).body.data.level).toBe(
        'super_admin',
      );
      // The refused removal left no audit entry (the whole transaction rolled back).
      const log = (
        await sup
          .get('/platform/audit-logs?action=platform_admin.removed')
          .expect(200)
      ).body.data;
      expect(
        log.every(
          (l: { description: string }) =>
            !l.description.includes('super@example.test'),
        ),
      ).toBe(true);
    });
  });

  describe('platform settings', () => {
    it('anyone with admin rights reads them; only a super admin changes them', async () => {
      expect(
        (await admin.get('/platform/settings').expect(200)).body.data,
      ).toMatchObject({ platformName: 'StoreForge', defaultCurrency: 'INR' });
      await admin
        .patch('/platform/settings', { platformName: 'Hacked' })
        .expect(403);
      const res = await sup
        .patch('/platform/settings', {
          platformName: 'ForgeCo',
          supportEmail: 'Help@ForgeCo.test',
          defaultTimezone: 'UTC',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        platformName: 'ForgeCo',
        supportEmail: 'help@forgeco.test',
        defaultTimezone: 'UTC',
        defaultCurrency: 'INR',
      });
      const branding = await (
        await import('supertest')
      )
        .default(t.app.getHttpServer())
        .get('/api/v1/public/branding')
        .expect(200);
      expect(branding.body.data).toMatchObject({
        platformName: 'ForgeCo',
        supportEmail: 'help@forgeco.test',
      });
    });

    it('validates input and only logs what changed', async () => {
      await sup.patch('/platform/settings', { platformName: 'X' }).expect(400);
      await sup
        .patch('/platform/settings', { defaultStoreStatus: 'suspended' })
        .expect(400);
      await sup
        .patch('/platform/settings', { defaultCurrency: 'ZZZ9' })
        .expect(400);
      await sup
        .patch('/platform/settings', { platformName: 'ForgeCo' })
        .expect(200); // unchanged
      const log = (
        await sup
          .get('/platform/audit-logs?action=platform_settings.updated')
          .expect(200)
      ).body.data;
      expect(log).toHaveLength(1);
      expect(Object.keys(log[0].newData).sort()).toEqual([
        'defaultTimezone',
        'platformName',
        'supportEmail',
      ]);
    });
  });

  describe('audit log', () => {
    it('lists newest first with filters and pagination, and exposes the admins for a filter', async () => {
      const all = await sup.get('/platform/audit-logs?limit=5').expect(200);
      expect(all.body.meta.total).toBeGreaterThan(5);
      expect(all.body.data).toHaveLength(5);
      const times = all.body.data.map((l: { createdAt: string }) =>
        Date.parse(l.createdAt),
      );
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      const byAdmin = await sup
        .get(`/platform/audit-logs?admin=${w.superAdmin}`)
        .expect(200);
      expect(
        byAdmin.body.data.every(
          (l: { adminUserId: string }) => l.adminUserId === w.superAdmin,
        ),
      ).toBe(true);
      const today = new Date().toISOString().slice(0, 10);
      expect(
        (
          await sup
            .get(`/platform/audit-logs?from=${today}&to=${today}`)
            .expect(200)
        ).body.meta.total,
      ).toBeGreaterThan(0);
      expect(
        (
          await sup
            .get('/platform/audit-logs?from=2001-01-01&to=2001-01-02')
            .expect(200)
        ).body.meta.total,
      ).toBe(0);
      const admins = (await sup.get('/platform/audit-logs/admins').expect(200))
        .body.data;
      expect(admins.map((a: { email: string }) => a.email)).toEqual(
        expect.arrayContaining(['admin@example.test', 'super@example.test']),
      );
      await sup.get('/platform/audit-logs?action=made.up').expect(400);
      await sup.get('/platform/audit-logs?from=yesterday').expect(400);
    });

    it('is append-only: the table cannot be reached or changed even by the application role', async () => {
      await expect(
        t.db.pg.query("update admin_audit_logs set description = 'edited'"),
      ).rejects.toThrow();
      await expect(
        t.db.pg.query('delete from admin_audit_logs'),
      ).rejects.toThrow();
      await expect(
        t.db.pg.query('select * from admin_audit_logs'),
      ).rejects.toThrow();
    });
  });

  describe('usage analytics', () => {
    it('returns aggregate numbers only', async () => {
      const usage = (
        await sup.get(`/platform/organizations/${orgId}/usage`).expect(200)
      ).body.data;
      expect(usage).toMatchObject({
        products: 1,
        customers: 0,
        orders: 0,
        status: 'active',
      });
      expect(
        usage.storageBytes === null || typeof usage.storageBytes === 'number',
      ).toBe(true);
      expect(Object.keys(usage).sort()).toEqual([
        'createdAt',
        'customers',
        'lastActivity',
        'orders',
        'products',
        'status',
        'storageBytes',
      ]);
      await sup
        .get(`/platform/organizations/${randomUUID()}/usage`)
        .expect(404);
    });

    it('lists usage per organization, summarises, finds inactive organizations and charts new ones', async () => {
      const list = await sup
        .get('/platform/usage?sortBy=name&sortOrder=asc')
        .expect(200);
      expect(list.body.meta.total).toBe(3);
      expect(list.body.data[0]).toHaveProperty('slug', 'alpha-shop');
      const summary = (
        await sup.get('/platform/usage/summary?inactiveDays=30').expect(200)
      ).body.data;
      expect(summary).toMatchObject({
        totalOrganizations: 3,
        active: 3,
        suspended: 0,
      });
      const inactive = (
        await sup.get('/platform/usage/inactive?days=30&limit=2').expect(200)
      ).body.data;
      expect(inactive.rows.length).toBeLessThanOrEqual(2);
      const series = (
        await sup.get('/platform/usage/new-organizations').expect(200)
      ).body.data;
      expect(series).toMatchObject({ bucket: 'week', total: 3 });
      const swapped = (
        await sup
          .get(
            '/platform/usage/new-organizations?from=2026-12-31&to=2026-01-01',
          )
          .expect(200)
      ).body.data;
      expect(swapped.from <= swapped.to).toBe(true);
      await sup.get('/platform/usage/summary?inactiveDays=45').expect(400);
      await sup.get('/platform/usage/new-organizations?from=nope').expect(400);
    });
  });

  describe('rate limits', () => {
    it('limits organization deletion to 5 attempts per 10 minutes per admin, counting every attempt', async () => {
      const limited = await as(t, w.admin, undefined, { ip: '192.0.2.50' });
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++)
        statuses.push(
          (await limited.delete(`/platform/organizations/${randomUUID()}`))
            .status,
        );
      expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
      expect(statuses.slice(5)).toEqual([429, 429]);
      // Other buckets and other admins are unaffected.
      await sup
        .patch(`/platform/organizations/${randomUUID()}`, {
          companyName: 'Nope Nope',
        })
        .expect(404);
    });
  });

  describe('deleting an organization', () => {
    it('removes the organization and all of its data, and the sign-ins that belong nowhere else', async () => {
      const probe = await createOrg(sup, {
        companyName: 'Doomed Inc',
        storeName: 'Doomed',
        storeSlug: 'doomed-store',
        ownerEmail: 'doomed@example.test',
      }).expect(201);
      const doomed = probe.body.data;
      const owner = await as(t, doomed.ownerId);
      await owner
        .post('/products', { name: 'Doomed Item', price: '5' })
        .expect(201);
      await owner
        .post('/customers', { fullName: 'D C', email: 'dc@example.test' })
        .expect(201);

      await sup
        .delete(`/platform/organizations/${doomed.tenantId}`)
        .expect(200);
      expect(t.authAdmin.deleted).toContain(doomed.ownerId);
      await sup.get(`/platform/organizations/${doomed.tenantId}`).expect(404);
      const rest = await t.db.asOwner((pg) =>
        pg.query(
          'select (select count(*) from products where tenant_id = $1)::int as p, (select count(*) from customers where tenant_id = $1)::int as c, (select count(*) from stores where tenant_id = $1)::int as s',
          [doomed.tenantId],
        ),
      );
      expect(rest.rows[0]).toEqual({ p: 0, c: 0, s: 0 });
      await sup
        .delete(`/platform/organizations/${doomed.tenantId}`)
        .expect(404);
    });
  });
});
