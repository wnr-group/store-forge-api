import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { rowsOf } from '../../src/database/database.service.js';
import { encryptSecret } from '../../src/modules/payments/credentials-crypto.js';
import { captureEvidence } from './qa-evidence/writer.js';
import {
  asUser,
  createTestDb,
  createUser,
  provision,
  type TestDb,
} from './pglite.js';
import { seedWorld, type World } from './world.js';

/**
 * Shared fixtures for the payments database specs (PG layer): the real migrations on PGlite, the real
 * `storeforge_app` -> `SET LOCAL ROLE authenticated` request path. PGlite is a single-connection Postgres, so these tests
 * prove SQL grants, RLS policies, constraints and upsert behaviour as PGlite implements them. They do NOT prove real
 * Supabase default privileges, real PostgREST (AC-RLS-11b) or multi-connection concurrency (AC-API-09b).
 */

export const KEY_ENV = {
  CREDENTIALS_ENCRYPTION_KEY_V1:
    process.env.QA_SYNTH_KEY_B64 ?? randomBytes(32).toString('base64'),
  CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
};
export const SYNTH_SECRET =
  process.env.QA_SYNTH_SECRET ?? `SYNTH${randomBytes(10).toString('hex')}`;
export const TABLE = 'public.tenant_razorpay_config';
export const SECRET_COLUMNS = [
  'secret_ciphertext',
  'iv',
  'auth_tag',
  'key_version',
];

/** Postgres SQLSTATE of an error, however many wrappers (Drizzle, PGlite) it travelled through. */
export function sqlstate(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code))
      return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}
export async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return sqlstate(error) ?? 'error';
  }
}

export const keyId = (mode: 'test' | 'live' = 'test') =>
  `rzp_${mode}_${randomBytes(6).toString('hex')}`;

/** Registers the database lifecycle for one spec file and returns stable handles (filled in by beforeAll). */
export function usePaymentsDb() {
  const t = {} as TestDb;
  const w = {} as World;
  const x = {} as {
    staffA: string;
    ownerS: string;
    tenantS: string;
    ownerD: string;
    tenantD: string;
  };
  let tenantD: string;

  const own = <T>(fn: (pg: PGlite) => Promise<T>) => t.asOwner(fn);
  const rowOf = async (tenantId: string) =>
    own((pg) =>
      pg.query<Record<string, unknown>>(
        `select * from ${TABLE} where tenant_id = $1`,
        [tenantId],
      ),
    ).then((r) => r.rows[0]);
  /** Privileged insert (bypasses RLS) used to prepare a row for the policy tests. */
  const seedRow = async (
    tenantId: string,
    updatedBy: string | null,
    id = keyId(),
  ) => {
    const e = encryptSecret(SYNTH_SECRET, tenantId, KEY_ENV);
    await own((pg) =>
      pg.query(
        `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id) do update set key_id = excluded.key_id`,
        [tenantId, id, e.ciphertext, e.iv, e.authTag, e.keyVersion, updatedBy],
      ),
    );
    return id;
  };
  const clear = () => own((pg) => pg.query(`delete from ${TABLE}`));

  /** The plan's atomic upsert (bound parameters, no EXCLUDED), run through the real request path. */
  const upsertAs = (
    userId: string,
    tenantId: string,
    id: string,
    secret = SYNTH_SECRET,
  ) => {
    const e = encryptSecret(secret, tenantId, KEY_ENV);
    return asUser(t, userId, (tx) =>
      tx.execute(sql`
        insert into public.tenant_razorpay_config
          (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_at, updated_by)
        values (${tenantId}::uuid, ${id}, ${e.ciphertext}, ${e.iv}, ${e.authTag}, ${e.keyVersion}, now(), ${userId}::uuid)
        on conflict (tenant_id) do update set
          key_id = ${id}, secret_ciphertext = ${e.ciphertext}, iv = ${e.iv}, auth_tag = ${e.authTag},
          key_version = ${e.keyVersion}, updated_at = now(), updated_by = ${userId}::uuid`),
    );
  };
  const selectAs = (userId: string, columns: string, tenantId: string) =>
    asUser(t, userId, async (tx) =>
      rowsOf<Record<string, unknown>>(
        await tx.execute(
          sql.raw(
            `select ${columns} from ${TABLE} where tenant_id = '${tenantId}'`,
          ),
        ),
      ),
    );

  /** Runs `work` as `role` for one transaction, as the superuser connects, then rolls back. */
  async function asDbRole(
    role: string,
    work: (pg: PGlite) => Promise<unknown>,
  ) {
    return own(async (pg) => {
      await pg.exec(`begin; set local role ${role}`);
      try {
        return await work(pg);
      } finally {
        await pg.exec('rollback');
      }
    });
  }

  /** Evidence is written only for an evidence run, and only after the assertion passed. */
  const evidence = (
    acId: string,
    actualResult: string,
    observed: object,
    assert: () => void,
  ) =>
    captureEvidence({
      acId,
      folder: 'database-evidence',
      layer: 'PG',
      environment: 'pglite',
      actualResult,
      assert,
      content: () => ({ acId, layer: 'PG', environment: 'pglite', observed }),
    });

  beforeAll(async () => {
    Object.assign(t, await createTestDb());
    Object.assign(w, await seedWorld(t));
    x.staffA = await createUser(t, 'staff@example.test', 'Staff A');
    await own((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'staff','{}'::jsonb,'active')",
        [w.tenantA, x.staffA],
      ),
    );
    x.ownerS = await createUser(t, 'owner.s@example.test', 'Owner S');
    x.tenantS = (
      await provision(t, w.superAdmin, x.ownerS, 'suspended-shop')
    ).tenant_id;
    await asUser(t, w.superAdmin, (tx) =>
      tx.execute(
        sql`select public.platform_set_tenant_status(${x.tenantS}::uuid, 'suspended')`,
      ),
    );
    x.ownerD = await createUser(t, 'owner.d@example.test', 'Owner D');
    x.tenantD = (
      await provision(t, w.superAdmin, x.ownerD, 'disabled-shop')
    ).tenant_id;
    await own((pg) =>
      pg.query(
        "update memberships set status = 'disabled' where tenant_id = $1 and user_id = $2",
        [x.tenantD, x.ownerD],
      ),
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  return {
    t,
    w,
    x,
    own,
    rowOf,
    seedRow,
    clear,
    upsertAs,
    selectAs,
    asDbRole,
    evidence,
  };
}
