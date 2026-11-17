/**
 * `npm run db:migrate` - applies src/database/migrations/*.sql with Drizzle's migrator, as the privileged owner role
 * (DIRECT_URL: direct connection or SESSION pooler, never the transaction pooler and never `storeforge_app`).
 * All pending migrations run in ONE transaction: a failure leaves the database exactly as it was.
 *
 *   --reset-log   Forget the migration history, but ONLY when the public schema has no tables at all. Use it after the
 *                 tables were deleted by hand: the log would otherwise claim they still exist and skip everything.
 *   --clean-leftovers
 *                 Also drop the StoreForge functions (public.*) and storage policies (products_objects_*) that survive
 *                 when tables are deleted by hand, because the migrations recreate them and would stop with "already
 *                 exists". Same safety check: only when the public schema has no tables. The `products` bucket, the
 *                 `storeforge_app` role and extensions are left alone.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { resolve } from 'node:path';

const url = process.env.DIRECT_URL;
if (!url) {
  console.error(
    'DIRECT_URL is required (privileged owner connection, see README).',
  );
  process.exit(2);
}
const sql = postgres(url, {
  prepare: false,
  max: 1,
  ssl: 'require',
  onnotice: () => undefined,
});

try {
  const wantsReset = process.argv.includes('--reset-log');
  const wantsClean = process.argv.includes('--clean-leftovers');
  if (wantsReset || wantsClean) {
    const [{ n }] =
      await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
    if (n > 0) {
      console.error(
        `Refusing to reset or clean: the public schema still has ${n} table(s).`,
      );
      process.exit(1);
    }
  }
  if (wantsClean) {
    await sql.begin(async (tx) => {
      const policies =
        await tx`select policyname from pg_policies where schemaname = 'storage' and policyname like 'products\_objects\_%'`;
      for (const { policyname } of policies)
        await tx.unsafe(
          `drop policy if exists "${policyname}" on storage.objects`,
        );
      const fns =
        await tx`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
      for (const { sig } of fns)
        await tx.unsafe(`drop function if exists ${sig} cascade`);
      console.log(
        `Dropped ${policies.length} storage polic(ies) and ${fns.length} function(s).`,
      );
    });
  }
  if (wantsReset) {
    if (
      (await sql`select to_regclass('drizzle.__drizzle_migrations') as t`)[0].t
    ) {
      const gone =
        await sql`delete from drizzle.__drizzle_migrations returning id`;
      console.log(
        `Reset the migration log (${gone.length} stale rows) because public has no tables.`,
      );
    }
  }
  await migrate(drizzle(sql), {
    migrationsFolder: resolve('src/database/migrations'),
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  });
  console.log('Migrations applied.');
} catch (error) {
  const e = error as Error & { cause?: Error };
  console.error(
    'Migration failed and was rolled back:',
    e.cause?.message ?? e.message,
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
