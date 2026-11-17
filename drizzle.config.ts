import { defineConfig } from 'drizzle-kit';

/**
 * The database schema is owned by this repository (D-004); its migrations live in src/database/migrations and are applied
 * with `npm run db:migrate`. This file exists for `drizzle-kit studio` / introspection only; do NOT run `push`, and
 * write new migrations by hand (see src/database/migrations/README.md).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  schemaFilter: ['public'],
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
