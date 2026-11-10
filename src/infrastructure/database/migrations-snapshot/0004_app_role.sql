-- Custom migration: the dedicated application login role.
--
-- The app connects as `storeforge_app` (via the Supabase transaction pooler).
-- Per request it opens a transaction, sets request.jwt.claims locally and runs
-- `SET LOCAL ROLE authenticated`, so ordinary RLS policies apply to the user.
--
--  * NOBYPASSRLS / NOSUPERUSER / no CREATE*: it can never skip row level security.
--  * NOINHERIT: it holds NO privileges of its own - not even those of
--    `authenticated` - until the transaction explicitly switches role.
--  * Member of `authenticated` ONLY: it cannot SET ROLE to anon, service_role
--    (BYPASSRLS) or postgres, even if application code were tricked into trying.
--  * Created WITHOUT a password. Set one manually (it must not live in git):
--      ALTER ROLE storeforge_app WITH PASSWORD '<strong random password>';
--    until then the role cannot log in.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storeforge_app') THEN
    CREATE ROLE storeforge_app
      LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE storeforge_app
      LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
--> statement-breakpoint
GRANT authenticated TO storeforge_app;
--> statement-breakpoint
-- Guard rails against runaway or abandoned transactions holding pooled connections.
ALTER ROLE storeforge_app SET statement_timeout = '15s';
--> statement-breakpoint
ALTER ROLE storeforge_app SET idle_in_transaction_session_timeout = '15s';
