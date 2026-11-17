import { pgSchema, uuid } from 'drizzle-orm/pg-core';

/**
 * Reference-only definition of Supabase's auth.users (owned by Supabase, never migrated here). Same shape as
 * `authUsers` from drizzle-orm/supabase, defined locally because that subpath resolves to a different (CommonJS)
 * copy of the types when Vercel type-checks the project, which breaks the foreign-key references.
 */
export const authUsers = pgSchema('auth').table('users', {
  id: uuid('id').primaryKey().notNull(),
});
