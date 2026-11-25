import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Read when the application module is loaded, so they are set before anything is imported.
const ENV = vi.hoisted(() => {
  const env = { CRON_SECRET: 'cron-secret-0123456789-0123456789-0123' };
  Object.assign(process.env, env);
  return env;
});

import { OrganizationsService } from '../src/modules/organizations/organizations.service.js';
import { MonitoringRecorder } from '../src/modules/monitoring/monitoring.recorder.js';
import { MonitoringService } from '../src/modules/monitoring/monitoring.service.js';
import { ReservationExpiryService } from '../src/modules/orders/reservation-expiry.service.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { TEST_ENV } from './support/test-env.js';
import {
  asUser,
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Overview = {
  api: {
    status: string;
    instanceUptimeSeconds: number;
    nodeVersion: string;
    environment: string;
  };
  database: { status: string; latencyMs: number | null };
  services: {
    key: string;
    status: string;
    latencyMs: number | null;
    detail: string | null;
  }[];
  errors: {
    available: boolean;
    last15Minutes: number;
    last24Hours: number;
    byHour: { hour: string; count: number }[];
    topIssues: {
      route: string;
      errorName: string;
      message: string;
      count: number;
    }[];
  };
  jobs: {
    job: string;
    health: string;
    runsLast24Hours: number;
    failuresLast24Hours: number;
    lastRun: {
      status: string;
      summary: Record<string, unknown> | null;
      error: string | null;
    } | null;
  }[];
  alerts: { id: string; severity: string }[];
  unavailableMetrics: { key: string; reason: string }[];
};

describe.skipIf(!migrationsAvailable)('platform monitoring (e2e)', () => {
  let t: TestApp;
  let w: World;
  let sup: Client;
  let admin: Client;
  let billing: Client;
  let support: Client;
  let alice: Client;
  let authUp = true;

  const overview = async (c: Client = admin) => {
    t.app.get(MonitoringService).resetCache();
    return (await c.get('/platform/monitoring/overview').expect(200)).body
      .data as Overview;
  };
  const clearMonitoring = () =>
    t.db.asOwner(async (pg) => {
      await pg.query('delete from platform_error_events');
      await pg.query('delete from platform_job_runs');
    });
  const job = (path: string, auth?: string) => {
    let r = request(t.app.getHttpServer())
      .get(`/api/v1/internal/jobs/${path}`)
      .set('X-Forwarded-For', '10.7.0.1');
    if (auth) r = r.set('Authorization', auth);
    return r;
  };
  const cron = `Bearer ${ENV.CRON_SECRET}`;

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
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown) =>
      String(input).includes('/auth/v1/health')
        ? authUp
          ? Promise.resolve(new Response('{}', { status: 200 }))
          : Promise.reject(new TypeError('connect ECONNREFUSED'))
        : Promise.reject(
            new TypeError('no network in tests'),
          )) as typeof fetch);
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

  describe('the overview', () => {
    it('reports what was measured, what was only configured, and what is not measured at all', async () => {
      const o = await overview();
      expect(o.api).toMatchObject({
        status: 'up',
        environment: expect.any(String),
      });
      expect(o.api.instanceUptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(o.database.status).toBe('up');
      expect(o.database.latencyMs).toBeGreaterThanOrEqual(0);
      const by = Object.fromEntries(o.services.map((s) => [s.key, s]));
      expect(by.database.status).toBe('up');
      expect(by.auth.status).toBe('up');
      expect(by.razorpay.status).toBe('not_configured'); // no platform keys in this test environment
      expect(by.scheduler.status).toBe('not_checked'); // configured, but a job run proves more than a setting
      expect(o.errors).toMatchObject({
        available: true,
        last15Minutes: 0,
        last24Hours: 0,
      });
      expect(o.errors.byHour).toHaveLength(24);
      expect(o.jobs.map((j) => j.job).sort()).toEqual([
        'billing',
        'expire-reservations',
        'purge-abandoned-carts',
        'reconcile-payments',
        'sync-shipments',
      ]);
      expect(o.jobs.every((j) => j.health === 'never_run')).toBe(true);
      expect(o.unavailableMetrics.map((m) => m.key)).toEqual(
        expect.arrayContaining(['cpu_memory', 'latency', 'queues']),
      );
      expect(o.unavailableMetrics.every((m) => m.reason.length > 10)).toBe(
        true,
      );
    });

    it('never returns an environment value, key, password or secret', async () => {
      const res = await admin.get('/platform/monitoring/overview').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = JSON.stringify(res.body);
      for (const secret of [
        ENV.CRON_SECRET,
        TEST_ENV.SUPABASE_ANON_KEY,
        TEST_ENV.SUPABASE_SERVICE_ROLE_KEY,
        TEST_ENV.AUTH_BFF_SECRET,
        'test-password',
        TEST_ENV.SUPABASE_URL,
        'storeforge_app',
      ])
        expect(body, secret).not.toContain(secret);
    });

    it('raises a critical alert when the sign-in service stops answering, and clears it when it returns', async () => {
      authUp = false;
      const down = await overview();
      expect(down.services.find((s) => s.key === 'auth')).toMatchObject({
        status: 'down',
        latencyMs: null,
      });
      expect(down.alerts[0]).toMatchObject({
        id: 'auth-down',
        severity: 'critical',
      });
      authUp = true;
      expect((await overview()).alerts.map((a) => a.id)).not.toContain(
        'auth-down',
      );
    });

    it('caches the outside check briefly so polling cannot hammer it', async () => {
      const spy = vi.mocked(globalThis.fetch);
      t.app.get(MonitoringService).resetCache();
      spy.mockClear();
      await admin.get('/platform/monitoring/overview').expect(200);
      await admin.get('/platform/monitoring/overview').expect(200);
      await admin.get('/platform/monitoring/overview').expect(200);
      expect(
        spy.mock.calls.filter((c) => String(c[0]).includes('/auth/v1/health')),
      ).toHaveLength(1);
    });
  });

  describe('server errors', () => {
    it('records an unhandled error with a route template and a sanitised message, and answers with the same request id', async () => {
      await clearMonitoring();
      const boom = vi
        .spyOn(t.app.get(OrganizationsService), 'listMine')
        .mockRejectedValue(
          new Error(
            'Cannot load jane.doe@example.com for tenant 0b9c6d1e-5f7a-4c1f-9b36-2f0d3c4e5a6b order 123456789',
          ),
        );
      const res = await alice.get('/organizations');
      boom.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Something went wrong. Please try again.'); // the client never sees the real message

      const list = (await sup.get('/platform/monitoring/errors').expect(200))
        .body;
      expect(list.meta.total).toBe(1);
      expect(list.data[0]).toMatchObject({
        method: 'GET',
        status: 500,
        errorName: 'Error',
        requestId: res.headers['x-request-id'],
      });
      expect(list.data[0].route).toContain('organizations');
      expect(list.data[0].message).toBe(
        'Cannot load <email> for tenant <id> order <n>',
      );
      expect(list.data[0].source).toBeTruthy();
    });

    it('stores no request body, header, token or user data', async () => {
      await clearMonitoring();
      const boom = vi
        .spyOn(t.app.get(OrganizationsService), 'listMine')
        .mockRejectedValue(new Error('exploded'));
      await alice.get('/organizations?search=hunter2-secret-query');
      boom.mockRestore();
      const dump = JSON.stringify(
        (
          await t.db.asOwner((pg) =>
            pg.query('select * from platform_error_events'),
          )
        ).rows,
      );
      for (const leak of [
        alice.token,
        'hunter2-secret-query',
        w.alice,
        'alice@example.test',
        'Authorization',
      ])
        expect(dump, leak).not.toContain(leak);
    });

    it('does not record client errors or expected refusals', async () => {
      await clearMonitoring();
      await alice.get('/platform/monitoring/overview').expect(403);
      await alice.get('/no-such-route').expect(404);
      await alice.post('/products', { name: '' }).expect(400);
      await request(t.app.getHttpServer())
        .get('/api/v1/organizations')
        .expect(401);
      expect(
        (
          await t.db.asOwner((pg) =>
            pg.query('select count(*)::int as n from platform_error_events'),
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    });

    it('counts, groups and charts them, and raises alerts by rate', async () => {
      await clearMonitoring();
      const boom = vi
        .spyOn(t.app.get(OrganizationsService), 'listMine')
        .mockRejectedValue(new Error('same failure'));
      for (let i = 0; i < 5; i++) await alice.get('/organizations');
      boom.mockRestore();
      let o = await overview();
      expect(o.errors).toMatchObject({
        available: true,
        last15Minutes: 5,
        last24Hours: 5,
      });
      expect(o.errors.byHour.reduce((a, h) => a + h.count, 0)).toBe(5);
      expect(o.errors.byHour.at(-1)!.count).toBe(5);
      expect(o.errors.topIssues).toHaveLength(1);
      expect(o.errors.topIssues[0]).toMatchObject({
        count: 5,
        message: 'same failure',
      });
      expect(o.alerts.find((a) => a.id === 'error-rate')).toMatchObject({
        severity: 'warning',
      });

      const recorder = t.app.get(MonitoringRecorder);
      for (let i = 0; i < 20; i++)
        await recorder.recordError({
          method: 'GET',
          route: '/x',
          status: 500,
          error: new Error(`failure ${i}`),
          requestId: null,
        });
      o = await overview();
      expect(o.errors.last15Minutes).toBe(25);
      expect(o.alerts[0]).toMatchObject({
        id: 'error-spike',
        severity: 'critical',
      });
    });

    it('caps how many it records per minute, so an outage cannot flood the table', async () => {
      await clearMonitoring();
      const recorder = t.app.get(MonitoringRecorder);
      for (let i = 0; i < 230; i++)
        await recorder.recordError({
          method: 'GET',
          route: '/flood',
          status: 503 + 0,
          error: new Error('flood'),
          requestId: null,
        });
      const n = (
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from platform_error_events'),
        )
      ).rows[0] as { n: number };
      expect(n.n).toBe(200);
    });

    it('searches and pages the list', async () => {
      await clearMonitoring();
      const recorder = t.app.get(MonitoringRecorder);
      await recorder.recordError({
        method: 'POST',
        route: '/api/v1/orders/:id',
        status: 500,
        error: new TypeError('alpha problem'),
        requestId: 'req-search-0001',
      });
      await recorder.recordError({
        method: 'GET',
        route: '/api/v1/products',
        status: 502,
        error: new Error('beta problem'),
        requestId: null,
      });
      const all = (
        await admin.get('/platform/monitoring/errors?limit=1').expect(200)
      ).body;
      expect(all.meta).toMatchObject({ total: 2, limit: 1 });
      expect(
        (
          await admin
            .get('/platform/monitoring/errors?search=alpha')
            .expect(200)
        ).body.data[0],
      ).toMatchObject({ errorName: 'TypeError', requestId: 'req-search-0001' });
      expect(
        (
          await admin
            .get('/platform/monitoring/errors?search=orders')
            .expect(200)
        ).body.meta.total,
      ).toBe(1);
      expect(
        (await admin.get('/platform/monitoring/errors?search=%25').expect(200))
          .body.meta.total,
      ).toBe(0);
    });
  });

  describe('scheduled jobs', () => {
    it('records a successful run with a numeric summary, and marks the job healthy', async () => {
      await clearMonitoring();
      const res = await job('expire-reservations', cron);
      expect(res.status).toBe(200);
      const o = await overview();
      const j = o.jobs.find((x) => x.job === 'expire-reservations')!;
      expect(j).toMatchObject({
        health: 'ok',
        runsLast24Hours: 1,
        failuresLast24Hours: 0,
      });
      expect(j.lastRun).toMatchObject({ status: 'ok' });
      expect(j.lastRun!.summary).toMatchObject({
        tenants: expect.any(Number),
        orders: expect.any(Number),
      });
    });

    it('records a failed run with a sanitised error, still fails the call, and raises an alert', async () => {
      await clearMonitoring();
      const spy = vi
        .spyOn(t.app.get(ReservationExpiryService), 'expireDue')
        .mockRejectedValue(
          new Error('Lost connection to jane@example.com tenant 123456789'),
        );
      const res = await job('expire-reservations', cron);
      spy.mockRestore();
      expect(res.status).toBe(500);
      const o = await overview();
      const j = o.jobs.find((x) => x.job === 'expire-reservations')!;
      expect(j).toMatchObject({ health: 'failing', failuresLast24Hours: 1 });
      expect(j.lastRun).toMatchObject({
        status: 'failed',
        error: 'Lost connection to <email> tenant <n>',
      });
      expect(
        o.alerts.find((a) => a.id === 'job-failing:expire-reservations'),
      ).toMatchObject({ severity: 'warning' });
    });

    it('calls a job late only after it has run and then stopped', async () => {
      await clearMonitoring();
      await t.db.asOwner((pg) =>
        pg.query(
          "insert into platform_job_runs (job, status, started_at, finished_at, duration_ms) values ('expire-reservations', 'ok', now() - interval '3 hours', now() - interval '3 hours', 40)",
        ),
      );
      const o = await overview();
      expect(o.jobs.find((x) => x.job === 'expire-reservations')!.health).toBe(
        'late',
      );
      expect(o.alerts.map((a) => a.id)).toContain(
        'job-late:expire-reservations',
      );
      expect(o.jobs.find((x) => x.job === 'billing')!.health).toBe('never_run');
      expect(o.alerts.map((a) => a.id)).not.toContain('job-late:billing');
    });

    it('records every scheduled route, and nothing for a call that was refused', async () => {
      await clearMonitoring();
      expect((await job('expire-reservations')).status).toBe(401);
      expect(
        (await job('billing', 'Bearer wrong-secret-wrong-secret-wrong-1'))
          .status,
      ).toBe(401);
      expect(
        (
          await t.db.asOwner((pg) =>
            pg.query('select count(*)::int as n from platform_job_runs'),
          )
        ).rows[0],
      ).toEqual({ n: 0 });
      for (const name of [
        'expire-reservations',
        'purge-abandoned-carts',
        'reconcile-payments',
        'sync-shipments',
        'billing',
      ]) {
        const r = await job(name, cron);
        expect(r.status, name).toBe(200);
      }
      const runs = (
        await sup.get('/platform/monitoring/jobs?limit=50').expect(200)
      ).body;
      expect(runs.meta.total).toBe(5);
      expect(runs.data.map((r: { job: string }) => r.job).sort()).toEqual([
        'billing',
        'expire-reservations',
        'purge-abandoned-carts',
        'reconcile-payments',
        'sync-shipments',
      ]);
      expect(
        runs.data.every(
          (r: { status: string; durationMs: number }) =>
            r.status === 'ok' && r.durationMs >= 0,
        ),
      ).toBe(true);
    });

    it('filters the run history and rejects unknown filters', async () => {
      const onlyBilling = (
        await admin.get('/platform/monitoring/jobs?job=billing').expect(200)
      ).body;
      expect(
        onlyBilling.data.every((r: { job: string }) => r.job === 'billing'),
      ).toBe(true);
      expect(
        (await admin.get('/platform/monitoring/jobs?status=failed').expect(200))
          .body.meta.total,
      ).toBe(0);
      await admin.get('/platform/monitoring/jobs?job=rm-rf').expect(400);
      await admin.get('/platform/monitoring/jobs?status=maybe').expect(400);
    });
  });

  describe('platform alerts that need no new data', () => {
    it('warns about failed billing webhooks and paid plans with no payment keys', async () => {
      await clearMonitoring();
      const paid = (
        await admin
          .post('/platform/plans', {
            code: 'paid',
            name: 'Paid',
            monthlyPrice: '100',
            yearlyPrice: '1000',
          })
          .expect(201)
      ).body.data.id;
      await sup
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: paid,
        })
        .expect(200);
      await t.db.asOwner((pg) =>
        pg.query(
          "insert into billing_webhook_events (event_id, event_type, status) values ('evt_mon_failed', 'payment.captured', 'failed')",
        ),
      );
      const ids = (await overview()).alerts.map((a) => a.id);
      expect(ids).toContain('billing-webhooks-failing');
      expect(ids).toContain('billing-payments-not-configured');
    });
  });

  describe('who can see it, and who can write it', () => {
    it('is for Super and Platform Admins only', async () => {
      for (const c of [sup, admin]) {
        await c.get('/platform/monitoring/overview').expect(200);
        await c.get('/platform/monitoring/errors').expect(200);
        await c.get('/platform/monitoring/jobs').expect(200);
      }
      for (const c of [billing, support, alice]) {
        await c.get('/platform/monitoring/overview').expect(403);
        await c.get('/platform/monitoring/errors').expect(403);
        await c.get('/platform/monitoring/jobs').expect(403);
      }
      expect(
        (
          await request(t.app.getHttpServer()).get(
            '/api/v1/platform/monitoring/overview',
          )
        ).status,
      ).toBe(401);
    });

    it('cannot be written by any signed-in user, however privileged', async () => {
      for (const user of [w.superAdmin, w.admin, w.alice]) {
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql`select public.monitoring_record_error('GET', '/x', 500, 'Error', 'forged', null, null)`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql`select public.monitoring_record_job('billing', 'ok', now(), now(), null, null)`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(
              sql`insert into public.platform_error_events (method, route, status, error_name, message) values ('GET','/x',500,'E','forged')`,
            ),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(t.db, user, (tx) =>
            tx.execute(sql`delete from public.platform_job_runs`),
          ),
        ).rejects.toThrow();
      }
    });

    it('is invisible to tenant users at the database level', async () => {
      const n = await asUser(
        t.db,
        w.alice,
        async (tx) =>
          (await tx.execute(
            sql`select count(*)::int as n from public.platform_error_events`,
          )) as unknown,
      );
      const rows =
        (n as { rows?: { n: number }[] }).rows ?? (n as { n: number }[]);
      expect(rows[0].n).toBe(0);
    });
  });
});
