/** Read-only: what is in the database right now? `npm run db:state` (uses DIRECT_URL). */
import postgres from 'postgres';

const url = process.env.DIRECT_URL;
if (!url) {
  console.error('DIRECT_URL is required.');
  process.exit(2);
}
const sql = postgres(url, { prepare: false, max: 1, ssl: 'require' });
try {
  const tables =
    await sql`select table_schema, count(*)::int as n from information_schema.tables
    where table_schema in ('public','drizzle') group by 1 order by 1`;
  console.log('tables per schema:', JSON.stringify(tables));
  const log =
    await sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (log[0].t) {
    const rows =
      await sql`select count(*)::int as n, max(created_at) as latest from drizzle.__drizzle_migrations`;
    console.log('migration log rows:', JSON.stringify(rows[0]));
  } else console.log('migration log: absent');
  const role =
    await sql`select rolname from pg_roles where rolname = 'storeforge_app'`;
  console.log('storeforge_app role exists:', role.length > 0);
  const fns =
    await sql`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`;
  console.log('public functions:', fns[0].n);
} finally {
  await sql.end();
}
