/**
 * `npm run db:verify-schema` - needs the OWNER connection (information_schema hides columns the app role cannot access,
 * so the app role would report every table as missing): DATABASE_URL=$DIRECT_URL npm run db:verify-schema.
 * Fails when the Drizzle definitions in src/database/schema no longer match the live
 * database (the schema is owned by the Next.js repo's migrations; this repo creates none). Read-only.
 *
 *   DATABASE_URL=postgresql://storeforge_app.<ref>:...@...:6543/postgres npm run db:verify-schema
 */
import postgres from 'postgres';
import {
  COLUMNS_SQL,
  findSchemaDrift,
  type ColumnRow,
} from '../src/database/schema-drift.js';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL or DATABASE_URL is required.');
  process.exit(2);
}

const sql = postgres(url, {
  prepare: false,
  max: 1,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : 'require',
});
try {
  const rows = (await sql.unsafe(COLUMNS_SQL)) as unknown as ColumnRow[];
  const problems = findSchemaDrift(rows);
  if (problems.length) {
    console.error(
      `Schema drift (${problems.length}):\n - ${problems.join('\n - ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('Drizzle schema matches the database.');
  }
} finally {
  await sql.end();
}
