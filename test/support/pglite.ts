import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbSchema } from '../../src/database/database.types.js';
import type { PlatformAdminRole } from '../../src/database/schema/enums.js';
import {
  DatabaseService,
  rowsOf,
} from '../../src/database/database.service.js';

/**
 * Database integration harness.
 *
 * The REAL schema is applied from src/database/migrations (a copy of the Next.js repo's drizzle/0000-0024), including
 * every table, trigger, RLS policy and SECURITY DEFINER function. Set STOREFORGE_MIGRATIONS_DIR to test another folder.
 * When it is missing the database-backed suites are skipped with a clear message instead of silently passing.
 */
export const MIGRATIONS_DIR = resolve(
  process.env.STOREFORGE_MIGRATIONS_DIR ?? 'src/database/migrations',
);
export const migrationsAvailable = existsSync(
  resolve(MIGRATIONS_DIR, 'meta/_journal.json'),
);
if (!migrationsAvailable) {
  console.warn(
    `[tests] Migrations not found at ${MIGRATIONS_DIR}. Set STOREFORGE_MIGRATIONS_DIR. Database-backed suites are SKIPPED.`,
  );
}

/** Minimal stand-in for the parts of Supabase the migrations depend on: the `auth` schema, auth.uid() and roles. */
const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  create role authenticator nologin;
  grant authenticated to authenticator;
  create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

/** Extra auth columns/tables the demo seed writes (mirrors real Supabase). */
const FULL_AUTH_STUB = `
  alter table auth.users
    add column instance_id uuid, add column aud text, add column role text,
    add column encrypted_password text, add column email_confirmed_at timestamptz,
    add column raw_app_meta_data jsonb, add column created_at timestamptz, add column updated_at timestamptz,
    add column confirmation_token text, add column recovery_token text,
    add column email_change text, add column email_change_token_new text;
  create table auth.identities (
    id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade,
    provider_id text not null, provider text not null, identity_data jsonb not null,
    last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
    unique (provider_id, provider)
  );
  create schema extensions;
`;

export interface TestDb {
  pg: PGlite;
  service: DatabaseService;
  /** Run privileged setup SQL (as the superuser), then return to the application login role. */
  asOwner<T>(fn: (pg: PGlite) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDb(
  options: { fullAuth?: boolean } = {},
): Promise<TestDb> {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(SUPABASE_STUB);
  if (options.fullAuth) await pg.exec(FULL_AUTH_STUB);
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_DIR });

  const db = drizzle(pg, { schema: dbSchema });
  // The real pooled connection logs in as the application role; so does the test connection.
  await pg.exec('set session authorization storeforge_app');

  return {
    pg,
    service: DatabaseService.forTesting(db),
    async asOwner(fn) {
      await pg.exec('set session authorization postgres');
      try {
        return await fn(pg);
      } finally {
        await pg.exec('set session authorization storeforge_app');
      }
    },
    close: () => pg.close(),
  };
}

export async function createUser(
  t: TestDb,
  email: string,
  fullName?: string,
): Promise<string> {
  return t.asOwner(async (pg) => {
    const meta = JSON.stringify(fullName ? { full_name: fullName } : {});
    const res = await pg.query<{ id: string }>(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
      [email, meta],
    );
    return res.rows[0].id;
  });
}

/** Inserts a Platform Admin the way `npm run admin:create` does: a privileged write, never through the API. */
export async function createPlatformAdmin(
  t: TestDb,
  email = 'platform.admin@example.test',
  role: PlatformAdminRole = 'super_admin',
): Promise<string> {
  const id = await createUser(t, email, 'Platform Admin');
  await t.asOwner((pg) =>
    pg.query(
      'insert into platform_admins (user_id, role) values ($1, $2) on conflict do nothing',
      [id, role],
    ),
  );
  return id;
}

/** Runs `fn` acting as `userId` through the REAL request path (RLS enforced). */
export function asUser<T>(
  t: TestDb,
  userId: string,
  fn: (
    tx: Parameters<Parameters<DatabaseService['withUser']>[1]>[0],
  ) => Promise<T>,
) {
  return t.service.withUser(userId, fn);
}

/** Creates an organization the only way it can be created: provisioned by a Platform Admin. */
export async function provision(
  t: TestDb,
  adminId: string,
  ownerId: string,
  storeSlug: string,
  names: { tenant?: string; store?: string } = {},
) {
  return asUser(t, adminId, async (tx) => {
    const rows = rowsOf<{ r: { tenant_id: string; store_id: string } }>(
      await tx.execute(sql`select public.platform_provision_tenant(
        ${ownerId}::uuid, ${names.tenant ?? `${storeSlug} Inc`}, ${names.store ?? `${storeSlug} Store`}, ${storeSlug}) as r`),
    );
    return rows[0].r;
  });
}
