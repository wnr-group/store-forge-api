import { defineConfig } from 'drizzle-kit';

/**
 * The database schema is owned by the Next.js repo's migrations (drizzle/0000-0024). This file exists for
 * `drizzle-kit studio` / introspection only; do NOT run `generate` or `push` from this repo.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  schemaFilter: ['public'],
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
