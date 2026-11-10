# infrastructure

Reserved for technical adapters that modules depend on (database access, file storage, external clients). It is empty on purpose: nothing here has been designed or approved yet.

Before adding database code, read the recommendation and open decisions in [docs/architecture/overview.md](../../docs/architecture/overview.md). In particular, do not connect with the Supabase `postgres` or service-role credentials: Row Level Security is the tenant-isolation boundary and those roles bypass it.
