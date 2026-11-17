import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';

export type ColumnRow = {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  data_type: string;
};

/** Postgres `information_schema.columns.data_type` values that each Drizzle column type may legitimately map to. */
const COMPATIBLE: Record<string, string[]> = {
  PgUUID: ['uuid'],
  PgText: ['text'],
  PgBoolean: ['boolean'],
  PgInteger: ['integer'],
  PgBigInt53: ['bigint'],
  PgBigInt64: ['bigint'],
  PgTimestamp: ['timestamp with time zone', 'timestamp without time zone'],
  PgJsonb: ['jsonb'],
  PgArray: ['ARRAY'],
};

/** SQL that lists the columns of the public schema, for any driver. */
export const COLUMNS_SQL = `
  select table_name, column_name, is_nullable, data_type
  from information_schema.columns
  where table_schema = 'public'`;

/**
 * Compares the Drizzle table definitions with the real database (the schema is owned by the Next.js repo's migrations).
 * Returns human-readable problems: a missing table, a missing column, a type or nullability mismatch. Extra database
 * columns are allowed (the API simply does not use them), missing ones are not.
 */
export function findSchemaDrift(actual: ColumnRow[]): string[] {
  const byTable = new Map<string, Map<string, ColumnRow>>();
  for (const row of actual) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Map());
    byTable.get(row.table_name)!.set(row.column_name, row);
  }

  const problems: string[] = [];
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object' || value === null || !('getSQL' in value))
      continue;
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue; // not a table (enums, constants)
    }
    const columns = byTable.get(config.name);
    if (!columns) {
      problems.push(`table ${config.name} is missing`);
      continue;
    }
    for (const col of config.columns) {
      const found = columns.get(col.name);
      if (!found) {
        problems.push(`${config.name}.${col.name} is missing`);
        continue;
      }
      const accepted = COMPATIBLE[col.columnType];
      if (accepted && !accepted.includes(found.data_type))
        problems.push(
          `${config.name}.${col.name} is ${found.data_type}, expected ${accepted.join(' or ')}`,
        );
      const nullable = found.is_nullable === 'YES';
      if (col.notNull && nullable)
        problems.push(
          `${config.name}.${col.name} is nullable but the schema says NOT NULL`,
        );
    }
  }
  return problems;
}
