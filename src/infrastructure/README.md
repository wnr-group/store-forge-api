# infrastructure

Reserved for technical adapters that modules depend on. The database layer was built as `src/database/` (module, service, ported Drizzle schema, RLS-as-user transactions) because the migration brief named that layout, and Supabase Storage / Auth Admin access live in `src/modules/storage` and `src/modules/auth`. Move them here if the team prefers the original proposal; the module boundaries make that a rename.

Do not connect with the Supabase `postgres` or service-role credentials for queries: Row Level Security is the tenant-isolation boundary and those roles bypass it. The app refuses to start with a `postgres` database user.
