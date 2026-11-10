# migrations

A copy of the Next.js repository's migrations (`drizzle/0000` - `0024`), applied to Supabase with `npm run db:migrate` (needs `DIRECT_URL`, the privileged owner connection: direct or session pooler, never the transaction pooler).

- `npm run db:state` shows what is in the database (read-only).
- If tables were deleted by hand, the migration log still lists them as applied. Run `npm run db:migrate -- --reset-log --clean-leftovers`: it forgets the log and drops the surviving StoreForge functions and storage policies, but ONLY when the `public` schema has no tables. All migrations run in one transaction; a failure changes nothing.
- Deviation from the Next.js copy: `0004_app_role.sql` only runs `ALTER ROLE storeforge_app` when the existing role differs from the required attributes. On Supabase the `postgres` user cannot re-assert the superuser/replication flags, so the unconditional ALTER failed on a database where the role already existed. The end state is identical.
- Until D-004 is decided, **keep this folder in step with the Next.js repo** (copy new migrations in the same order, never edit applied ones). `npm run db:verify-schema` (with the owner connection) fails on drift.
- `drizzle.config.ts` is for `drizzle-kit studio` only. After migrating, set the app role's password and create a Platform Admin with the Next.js repo's `npm run admin:create` (see its README).
