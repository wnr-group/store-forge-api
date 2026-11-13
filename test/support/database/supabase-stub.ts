/**
 * Minimal stand-in for the parts of Supabase the migrations depend on:
 * the `auth` schema, auth.uid() and the anon/authenticated/service_role roles.
 * Everything else (tables, triggers, RLS, functions, roles) is the REAL Drizzle migration set.
 */
export const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  -- Same definition as Supabase's auth.uid(): supports both claim styles and empty settings.
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

/** Extra auth columns/tables the dev seed touches (mirrors real Supabase). */
export const FULL_AUTH_STUB = `
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
