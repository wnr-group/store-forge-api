import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const REAL_PG_URL =
  process.env.TEST_POSTGRES_URL ??
  'postgresql://postgres:postgres@127.0.0.1:17032/sf_concurrency_test';

export async function isRealPostgresAvailable(): Promise<boolean> {
  try {
    const testClient = postgres(REAL_PG_URL, { connect_timeout: 2, max: 1 });
    await testClient`SELECT 1`;
    await testClient.end();
    return true;
  } catch {
    return false;
  }
}

export async function setupRealPostgres(): Promise<postgres.Sql> {
  const adminClient = postgres(REAL_PG_URL, { max: 1 });

  // 1. Core extension and Supabase auth stubs
  await adminClient.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await adminClient.unsafe('CREATE SCHEMA IF NOT EXISTS auth;');
  await adminClient.unsafe(`
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
  `);
  await adminClient.unsafe(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
  `);

  for (const role of [
    'anon',
    'authenticated',
    'authenticator',
    'service_role',
  ]) {
    await adminClient.unsafe(`
      DO $$ BEGIN
        CREATE ROLE ${role} NOLOGIN;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  await adminClient.unsafe(`
    DO $$ BEGIN
      GRANT authenticated TO authenticator;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);

  await adminClient
    .unsafe(
      `
    DO $$ BEGIN
      ALTER ROLE service_role BYPASSRLS;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `,
    )
    .catch(() => {});

  await adminClient
    .unsafe(
      `
    DO $$ BEGIN
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `,
    )
    .catch(() => {});

  // Full auth stub columns & tables
  await adminClient.unsafe(`
    ALTER TABLE auth.users
      ADD COLUMN IF NOT EXISTS instance_id uuid,
      ADD COLUMN IF NOT EXISTS aud text,
      ADD COLUMN IF NOT EXISTS role text,
      ADD COLUMN IF NOT EXISTS encrypted_password text,
      ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb,
      ADD COLUMN IF NOT EXISTS created_at timestamptz,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS confirmation_token text,
      ADD COLUMN IF NOT EXISTS recovery_token text,
      ADD COLUMN IF NOT EXISTS email_change text,
      ADD COLUMN IF NOT EXISTS email_change_token_new text;
    CREATE TABLE IF NOT EXISTS auth.identities (
      id uuid primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      provider_id text not null,
      provider text not null,
      identity_data jsonb not null,
      last_sign_in_at timestamptz,
      created_at timestamptz,
      updated_at timestamptz,
      unique (provider_id, provider)
    );
    CREATE SCHEMA IF NOT EXISTS extensions;
  `);

  // 2. Drizzle migrations snapshot
  const migrationsFolder = resolve(
    process.cwd(),
    'src/infrastructure/database/migrations-snapshot',
  );
  const db = drizzle(adminClient);
  await migrate(db, { migrationsFolder });

  // 3. Ensure storeforge_app role and password
  await adminClient.unsafe(`
    DO $$ BEGIN
      CREATE ROLE storeforge_app WITH LOGIN PASSWORD 'test_password';
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE storeforge_app WITH LOGIN PASSWORD 'test_password';
    END $$;
  `);

  await adminClient.end();

  // Return a connection pool configured for real concurrent testing
  return postgres(REAL_PG_URL, { max: 10 });
}
