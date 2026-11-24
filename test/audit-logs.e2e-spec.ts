import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
type Entry = {
  id: string;
  action: string;
  entityType: string;
  adminUserId: string;
  organizationId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  previousData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  createdAt: string;
};

describe.skipIf(!migrationsAvailable)('platform audit log (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let alice: Client;
  let billingId: string;
  let supportId: string;

  const list = async (query = '', c: Client = sup) =>
    (await c.get(`/platform/audit-logs${query}`).expect(200)).body as {
      data: Entry[];
      meta: { total: number; page: number; limit: number };
    };

  /** A request with full control of the headers a proxy and a browser would send. */
  const raw = async (
    userId: string,
    method: 'patch' | 'post',
    path: string,
    body: object,
    headers: Record<string, string> = {},
  ) => {
    const token = (await as(t, userId)).token;
    return request(t.app.getHttpServer())
      [method](`/api/v1${path}`)
      .set({
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': '198.51.100.1',
        ...headers,
      })
      .send(body);
  };

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
    alice = await as(t, w.alice);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
    await t?.db.close();
  });

  describe('where an action came from', () => {
    it('records the address, user agent and request id, and returns the id to the caller', async () => {
      const res = await raw(
        w.admin,
        'patch',
        `/platform/organizations/${w.tenantA}`,
        { address: '12 Meta Street' },
        {
          'X-Forwarded-For': '203.0.113.7',
          'User-Agent': 'Mozilla/5.0 (audit test)',
          'X-Request-Id': 'req-audit-0001',
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('req-audit-0001');
      const [entry] = (await list('?action=organization.updated')).data;
      expect(entry).toMatchObject({
        adminUserId: w.admin,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (audit test)',
        requestId: 'req-audit-0001',
      });
    });

    it('replaces a request id that is not a plain id, and caps an oversized user agent', async () => {
      const res = await raw(
        w.admin,
        'patch',
        `/platform/organizations/${w.tenantA}`,
        { address: '13 Meta Street' },
        {
          'X-Request-Id': 'bad id\twith spaces',
          'User-Agent': 'U'.repeat(500),
        },
      );
      expect(res.status).toBe(200);
      const id = res.headers['x-request-id'] as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const [entry] = (await list('?action=organization.updated')).data;
      expect(entry.requestId).toBe(id);
      expect(entry.userAgent).toHaveLength(300);
    });

    it('gives every request an id, even one that is refused or public', async () => {
      const anon = await request(t.app.getHttpServer()).get('/api/v1/health');
      expect(anon.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      const denied = await alice.get('/platform/audit-logs');
      expect(denied.status).toBe(403);
      expect(denied.headers['x-request-id']).toBeTruthy();
    });

    it('takes the actor from the session, never from the request', async () => {
      const res = await raw(
        w.admin,
        'patch',
        `/platform/organizations/${w.tenantA}`,
        {
          address: '14 Meta Street',
          adminUserId: w.superAdmin,
          adminEmail: 'forged@example.test',
          ip: '1.1.1.1',
        },
      );
      expect(res.status).toBe(400); // unknown fields are rejected outright
      expect(
        (await list('?action=organization.updated')).data.every(
          (e) => e.adminUserId === w.admin,
        ),
      ).toBe(true);
    });
  });

  describe('finding entries', () => {
    beforeAll(async () => {
      await admin
        .post('/platform/plans', {
          code: 'audit-plan',
          name: 'Audit Plan',
          monthlyPrice: '10',
          yearlyPrice: '100',
        })
        .expect(201);
      await sup
        .patch(`/platform/organizations/${w.tenantB}/status`, {
          status: 'suspended',
        })
        .expect(200);
      await sup
        .patch(`/platform/organizations/${w.tenantB}/status`, {
          status: 'active',
        })
        .expect(200);
    });

    it('filters by the kind of thing, the action, the actor, the organization and the date, alone or together', async () => {
      const plan = await list('?entity=plan');
      expect(plan.data.length).toBeGreaterThan(0);
      expect(plan.data.every((e) => e.entityType === 'plan')).toBe(true);

      const created = await list('?entity=plan&action=plan.created');
      expect(created.data.every((e) => e.action === 'plan.created')).toBe(true);
      expect(
        (await list('?entity=organization&action=plan.created')).meta.total,
      ).toBe(0);

      const byOrg = await list(`?org=${w.tenantB}`);
      expect(byOrg.data.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          'organization.suspended',
          'organization.reactivated',
        ]),
      );
      expect(byOrg.data.every((e) => e.organizationId === w.tenantB)).toBe(
        true,
      );

      const byActor = await list(`?admin=${w.superAdmin}&org=${w.tenantB}`);
      expect(byActor.meta.total).toBeGreaterThanOrEqual(2);
      expect(byActor.data.every((e) => e.adminUserId === w.superAdmin)).toBe(
        true,
      );
      expect(
        (
          await list(
            `?admin=${w.admin}&org=${w.tenantB}&action=organization.suspended`,
          )
        ).meta.total,
      ).toBe(0);

      const today = new Date().toISOString().slice(0, 10);
      expect(
        (await list(`?from=${today}&to=${today}&entity=plan`)).meta.total,
      ).toBeGreaterThan(0);
      expect(
        (await list('?from=2001-01-01&to=2001-01-31&entity=plan')).meta.total,
      ).toBe(0);
    });

    it('pages newest first and clamps a page that is past the end', async () => {
      const first = await list('?limit=2&page=1');
      expect(first.data).toHaveLength(2);
      const times = first.data.map((e) => Date.parse(e.createdAt));
      expect(times[0]).toBeGreaterThanOrEqual(times[1]);
      const far = await list('?limit=2&page=9999');
      expect(far.meta.page).toBe(Math.ceil(far.meta.total / 2));
      expect(far.data.length).toBeGreaterThan(0);
    });

    it('rejects filters it does not know', async () => {
      await sup.get('/platform/audit-logs?entity=spaceship').expect(400);
      await sup.get('/platform/audit-logs?action=made.up').expect(400);
      await sup.get('/platform/audit-logs?admin=not-a-uuid').expect(400);
      await sup.get('/platform/audit-logs?org=not-a-uuid').expect(400);
      await sup.get('/platform/audit-logs?from=2026-13-45x').expect(400);
    });

    it('lists the actions and kinds a screen can filter by', async () => {
      const f = (await admin.get('/platform/audit-logs/filters').expect(200))
        .body.data;
      expect(f.actions).toEqual(
        expect.arrayContaining([
          'organization.created',
          'plan.created',
          'invoice.issued',
          'entitlement.feature_overridden',
        ]),
      );
      expect(f.entityTypes).toEqual(
        expect.arrayContaining([
          'organization',
          'plan',
          'subscription',
          'invoice',
          'payment',
        ]),
      );
    });
  });

  describe('who may read it', () => {
    it('is open to Super and Platform Admins only', async () => {
      await list('', sup);
      await list('', admin);
      for (const c of [billing, support, alice]) {
        await c.get('/platform/audit-logs').expect(403);
        await c.get('/platform/audit-logs/filters').expect(403);
        await c.get('/platform/audit-logs/admins').expect(403);
        await c
          .get(`/platform/organizations/${w.tenantA}/activity`)
          .expect(c === alice ? 403 : 200);
      }
      const anon = await request(t.app.getHttpServer()).get(
        '/api/v1/platform/audit-logs',
      );
      expect(anon.status).toBe(401);
    });

    it('leaves a line in the server log, without any e-mail or token, when a request is denied', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await support.get('/platform/audit-logs').expect(403);
      await alice.get('/platform/audit-logs').expect(403);
      await support
        .post('/platform/plans', {
          code: 'nope-plan',
          name: 'No',
          monthlyPrice: '1',
          yearlyPrice: '1',
        })
        .expect(403);
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('platform access denied'));
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(
        lines.some((l) => l.includes(supportId) && l.includes('audit:read')),
      ).toBe(true);
      expect(
        lines.some(
          (l) => l.includes(w.alice) && l.includes('not a platform admin'),
        ),
      ).toBe(true);
      for (const l of lines) {
        expect(l).not.toMatch(/@|Bearer|eyJ/);
        expect(l).toMatch(/request [0-9a-f-]{36}/);
      }
      warn.mockRestore();
    });
  });

  describe('nobody can change history', () => {
    it('offers no route that edits or deletes an entry', async () => {
      const any = (await list('?limit=1')).data[0].id;
      for (const call of [
        () =>
          sup.patch(`/platform/audit-logs/${any}`, { description: 'edited' }),
        () => sup.put(`/platform/audit-logs/${any}`, { description: 'edited' }),
        () => sup.delete(`/platform/audit-logs/${any}`),
        () =>
          sup.post('/platform/audit-logs', { action: 'organization.created' }),
      ])
        expect((await call()).status).toBeGreaterThanOrEqual(404);
    });

    it('is closed to every signed-in database role, even a super admin', async () => {
      for (const user of [w.superAdmin, w.admin, w.alice]) {
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(sql`select * from public.admin_audit_logs`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql`insert into public.admin_audit_logs (admin_user_id, admin_email, action, entity_type, description) values (${user}::uuid, 'x', 'a.b', 'plan', 'forged')`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql`update public.admin_audit_logs set description = 'edited'`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(sql`delete from public.admin_audit_logs`),
          ),
        ).rejects.toThrow();
      }
    });

    it('rejects update, delete and truncate even for the table owner, so no column (metadata included) can be rewritten', async () => {
      for (const statement of [
        "update admin_audit_logs set description = 'edited'",
        "update admin_audit_logs set ip = '0.0.0.0'",
        'update admin_audit_logs set request_id = null',
        'delete from admin_audit_logs',
        'truncate admin_audit_logs',
      ])
        await expect(
          t.db.asOwner((pg) => pg.query(statement)),
          statement,
        ).rejects.toThrow();
      expect((await list()).meta.total).toBeGreaterThan(0);
    });

    it('only a platform admin can write through the function, and always as themselves', async () => {
      await expect(
        asUser(t.db, w.alice, (tx) =>
          tx.execute(
            sql`select public.platform_record_audit('organization.created', 'organization', null, null, 'forged by a tenant')`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asUser(t.db, billingId, (tx) =>
          tx.execute(
            sql`select public.platform_record_audit('invoice.issued', 'invoice', null, null, 'written by billing', null, null, ${JSON.stringify({ ip: '192.0.2.9', requestId: 'req-from-sql-1' })}::jsonb)`,
          ),
        ),
      ).resolves.toBeDefined();
      const row = (
        await t.db.asOwner((pg) =>
          pg.query(
            "select admin_user_id, admin_email, ip, request_id from admin_audit_logs where description = 'written by billing'",
          ),
        )
      ).rows[0] as {
        admin_user_id: string;
        admin_email: string;
        ip: string;
        request_id: string;
      };
      expect(row).toEqual({
        admin_user_id: billingId,
        admin_email: 'billing@example.test',
        ip: '192.0.2.9',
        request_id: 'req-from-sql-1',
      });
    });
  });

  describe('what never gets written', () => {
    it('strips anything that looks like a credential, at any depth', async () => {
      await asUser(t.db, w.admin, (tx) =>
        tx.execute(sql`select public.platform_record_audit('plan.updated', 'plan', null, null, 'redaction check',
          ${JSON.stringify({ password: 'hunter2-secret', ok: 'visible', nested: { apiKey: 'AKIA-SECRET', razorpay_secret: 's3', deep: [{ authToken: 't0k', note: 'fine' }] } })}::jsonb,
          ${JSON.stringify({ cookie: 'session=abc', clientSecret: 'cs', amount: 5 })}::jsonb)`),
      );
      const row = rowsOf<{
        previous_data: Record<string, unknown>;
        new_data: Record<string, unknown>;
      }>(
        (
          await t.db.asOwner((pg) =>
            pg.query(
              "select previous_data, new_data from admin_audit_logs where description = 'redaction check'",
            ),
          )
        ).rows,
      )[0];
      expect(row.previous_data).toEqual({
        password: '[redacted]',
        ok: 'visible',
        nested: {
          apiKey: '[redacted]',
          razorpay_secret: '[redacted]',
          deep: [{ authToken: '[redacted]', note: 'fine' }],
        },
      });
      expect(row.new_data).toEqual({
        cookie: '[redacted]',
        clientSecret: '[redacted]',
        amount: 5,
      });
    });

    it('holds no password, token or key from the flows exercised in this file', async () => {
      await sup
        .post('/platform/admins', {
          fullName: 'Audit Probe',
          email: 'probe@example.test',
          password: 'Sup3r-Secret-Pw',
          role: 'support_admin',
        })
        .expect(201);
      const dump = JSON.stringify(
        (await t.db.asOwner((pg) => pg.query('select * from admin_audit_logs')))
          .rows,
      );
      for (const secret of [
        'Sup3r-Secret-Pw',
        'Passw0rd-1',
        'hunter2-secret',
        'AKIA-SECRET',
        sup.token,
      ])
        expect(dump).not.toContain(secret);
      expect(dump).toContain('probe@example.test'); // the facts are there, the secret is not
    });
  });
});
