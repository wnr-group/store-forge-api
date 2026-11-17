import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as relations from './relations.js';
import * as schema from './schema/index.js';

export const dbSchema = { ...schema, ...relations };
export type Database = PostgresJsDatabase<typeof dbSchema>;
