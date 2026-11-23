import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { rowsOf } from '../../src/database/database.service.js';
import { as, createTestApp, type TestApp } from './app.js';
import {
  KEY_B64,
  keyId,
  LogRecorder,
  SECRET,
  secretOf,
} from './payments-secrets.js';
import { captureEvidence } from './qa-evidence/writer.js';
import { asUser, createTestDb, createUser, provision } from './pglite.js';
import { seedWorld, type World } from './world.js';

/**
 * Shared fixtures for the payments HTTP specs (HTTP layer): the real NestJS AppModule over a PGlite database with test-signed
 * JWTs. The harness stubs Supabase Auth, Storage and the HTTP request logger (skipped under test), so these specs cannot prove
 * those; see the plan's layer table. The synthetic secret and encryption key exist only in memory (or in the evidence run's
 * environment) and are the leak sentinels.
 */

export const TABLE = 'public.tenant_razorpay_config';

export const KEY_VARS = [
  'CREDENTIALS_ENCRYPTION_KEY_V1',
  'CREDENTIALS_ENCRYPTION_KEY_CURRENT',
] as const;

export interface PaymentsHttp {
  t: TestApp;
  w: World;
  x: {
    staffA: string;
    multi: string;
    orgOne: string;
    orgTwo: string;
    mixed: string;
    mixedStaffOrg: string;
    mixedOwnerOrg: string;
    ownerS: string;
    tenantS: string;
    ownerD: string;
    tenantD: string;
  };
  logs: LogRecorder;
  /** The stored row, every column, read as the database owner (tests only). */
  row(tenantId: string): Promise<Record<string, unknown> | undefined>;
  count(): Promise<number>;
  clear(): Promise<void>;
  /** Authenticated client with a fixed client address (rate limits are per address). */
  client(userId: string, org?: string, ip?: string): ReturnType<typeof as>;
  /** A request with full control of the headers, for blank and malformed `X-Organization-Id`. */
  raw(
    method: 'get' | 'put' | 'delete',
    userId: string | null,
    headers?: Record<string, string>,
    body?: object,
  ): Promise<request.Response>;
  put(
    userId: string,
    org: string,
    body?: object,
    ip?: string,
  ): Promise<request.Response>;
  evidence(
    acId: string,
    folder: 'api-evidence' | 'logs' | 'database-evidence',
    actualResult: string,
    observed: object | string,
    assert: () => void,
  ): ReturnType<typeof captureEvidence>;
}

/** Registers the application lifecycle for one spec file and returns stable handles (filled in by beforeAll). */
export function usePaymentsHttp(): PaymentsHttp {
  const logs = new LogRecorder();
  const h = { logs, x: {} } as PaymentsHttp;
  let ipSeq = 0;
  const freshIp = () =>
    `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

  beforeAll(async () => {
    const db = await createTestDb();
    const w = await seedWorld(db);
    const own = db.asOwner.bind(db);

    const staffA = await createUser(db, 'staff.a@example.test', 'Staff A');
    await own((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'staff','{}'::jsonb,'active')",
        [w.tenantA, staffA],
      ),
    );
    // Owner of two organizations.
    const multi = await createUser(db, 'multi@example.test', 'Multi Owner');
    const orgOne = (await provision(db, w.superAdmin, multi, 'multi-one'))
      .tenant_id;
    const orgTwo = (await provision(db, w.superAdmin, multi, 'multi-two'))
      .tenant_id;
    // Staff in the first organization they joined, Owner of the second.
    const mixed = await createUser(db, 'mixed@example.test', 'Mixed User');
    await own((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'staff','{}'::jsonb,'active')",
        [w.tenantA, mixed],
      ),
    );
    const mixedOwnerOrg = (
      await provision(db, w.superAdmin, mixed, 'mixed-owned')
    ).tenant_id;
    // Suspended tenant and a disabled Owner membership.
    const ownerS = await createUser(db, 'owner.s@example.test', 'Owner S');
    const tenantS = (await provision(db, w.superAdmin, ownerS, 'suspended-two'))
      .tenant_id;
    await asUser(db, w.superAdmin, (tx) =>
      tx.execute(
        sql`select public.platform_set_tenant_status(${tenantS}::uuid, 'suspended')`,
      ),
    );
    const ownerD = await createUser(db, 'owner.d@example.test', 'Owner D');
    const tenantD = (await provision(db, w.superAdmin, ownerD, 'disabled-two'))
      .tenant_id;
    await own((pg) =>
      pg.query(
        "update memberships set status = 'disabled' where tenant_id = $1 and user_id = $2",
        [tenantD, ownerD],
      ),
    );

    const t = await createTestApp(db);
    Object.assign(h, {
      t,
      w,
      x: {
        staffA,
        multi,
        orgOne,
        orgTwo,
        mixed,
        mixedStaffOrg: w.tenantA,
        mixedOwnerOrg,
        ownerS,
        tenantS,
        ownerD,
        tenantD,
      },
    });
    // Every Logger instance (guards, filter, payments events) now writes to the recorder.
    Logger.overrideLogger(logs);
  });

  afterAll(async () => {
    Logger.overrideLogger(['error', 'warn']);
    await h.t?.close();
    await h.t?.db.close();
  });

  beforeEach(() => {
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', KEY_B64);
    vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_CURRENT', '1');
    logs.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  h.row = async (tenantId) =>
    h.t.db
      .asOwner((pg) =>
        pg.query<Record<string, unknown>>(
          `select * from ${TABLE} where tenant_id = $1`,
          [tenantId],
        ),
      )
      .then((r) => r.rows[0]);
  h.count = async () =>
    h.t.db
      .asOwner((pg) =>
        pg.query<{ n: number }>(`select count(*)::int as n from ${TABLE}`),
      )
      .then((r) => r.rows[0].n);
  h.clear = async () => {
    await h.t.db.asOwner((pg) => pg.query(`delete from ${TABLE}`));
  };
  h.client = (userId, org, ip) => as(h.t, userId, org, { ip: ip ?? freshIp() });
  h.raw = async (method, userId, headers = {}, body) => {
    const { signToken } = await import('./app.js');
    const token = userId ? await signToken(userId) : null;
    const r = request(h.t.app.getHttpServer())
      [method]('/api/v1/payments/razorpay')
      .set({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Forwarded-For': freshIp(),
        ...headers,
      });
    return body ? r.send(body) : r;
  };
  h.put = async (userId, org, body, ip) =>
    (await h.client(userId, org, ip)).put('/payments/razorpay', {
      keyId: keyId(),
      keySecret: SECRET,
      ...body,
    });
  h.evidence = (acId, folder, actualResult, observed, assert) =>
    captureEvidence({
      acId,
      folder,
      layer: 'HTTP',
      environment: 'pglite',
      actualResult,
      assert,
      content: () =>
        typeof observed === 'string'
          ? observed
          : { acId, layer: 'HTTP', environment: 'pglite', observed },
    });
  return h;
}

export { KEY_B64, keyId, LogRecorder, rowsOf, SECRET, secretOf };
