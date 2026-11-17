import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLUMNS_SQL,
  findSchemaDrift,
  type ColumnRow,
} from '../src/database/schema-drift.js';
import {
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';

/** Migration / schema compatibility: the Drizzle definitions must match the REAL migrated database. */
describe.skipIf(!migrationsAvailable)('database compatibility (e2e)', () => {
  let db: TestDb;
  let rows: ColumnRow[];

  beforeAll(async () => {
    db = await createTestDb();
    rows = await db.asOwner(
      async (pg) => (await pg.query<ColumnRow>(COLUMNS_SQL)).rows,
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it('applies every migration of the owning repository without error', () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it('matches every Drizzle table and column to the migrated database', () => {
    expect(findSchemaDrift(rows)).toEqual([]);
  });

  it('detects drift: a dropped column and a retyped column are reported', () => {
    const mutated = rows
      .filter((r) => !(r.table_name === 'products' && r.column_name === 'sku'))
      .map((r) =>
        r.table_name === 'customers' && r.column_name === 'email'
          ? { ...r, data_type: 'integer' }
          : r,
      );
    const problems = findSchemaDrift(mutated);
    expect(problems).toContain('products.sku is missing');
    expect(
      problems.some((p) => p.startsWith('customers.email is integer')),
    ).toBe(true);
  });

  it('keeps the privileged tables out of reach of the application role (they are only reachable through functions)', async () => {
    for (const table of [
      'platform_admins',
      'platform_settings',
      'admin_audit_logs',
      'rate_limits',
    ]) {
      await expect(
        db.pg.query(`select 1 from ${table} limit 1`),
        table,
      ).rejects.toThrow();
    }
  });

  it('refuses a superuser connection: the RLS guard fails closed', async () => {
    await db.pg.exec('set session authorization postgres');
    try {
      const { DatabaseService } =
        await import('../src/database/database.service.js');
      const { drizzle } = await import('drizzle-orm/pglite');
      const { dbSchema } = await import('../src/database/database.types.js');
      const risky = DatabaseService.forTesting(
        drizzle(db.pg, { schema: dbSchema }),
      );
      await expect(
        risky.withUser('00000000-0000-4000-8000-000000000001', async () => 1),
      ).rejects.toThrow(/RLS guard failed/);
    } finally {
      await db.pg.exec('set session authorization storeforge_app');
    }
  });
});
