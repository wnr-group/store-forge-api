import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { AppConfig } from '../config/configuration.js';
import { NodeEnv } from '../config/env.validation.js';
import type { Database } from './database.types.js';
import { dbSchema } from './database.types.js';
import {
  rowsOf,
  withPublicContext,
  withUserContext,
  type DbTx,
} from './user-context.js';

export type { Database } from './database.types.js';
export type { DbTx } from './user-context.js';
export { rowsOf } from './user-context.js';

/**
 * The ONLY way application code reaches the database.
 *
 * It connects as the restricted `storeforge_app` login role through the Supabase transaction pooler and runs
 * every unit of work in a transaction that acts as the verified user (`SET LOCAL ROLE authenticated` plus the
 * user's id as JWT claims). Row level security therefore applies to every API query, independently of the
 * authorisation checks in the NestJS guards and services. See docs/AUTHENTICATION_MIGRATION_PLAN.md.
 *
 * There is deliberately no method that runs a query without an identity, other than `withPublic`, which uses
 * the same request role with NO user: it can only reach SECURITY DEFINER functions meant for anonymous callers.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private client?: ReturnType<typeof postgres>;
  protected db!: Database;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Test seam: wraps an already-built Drizzle database (e.g. PGlite). */
  static forTesting(db: unknown): DatabaseService {
    const service = Object.create(DatabaseService.prototype) as DatabaseService;
    service.db = db as Database;
    return service;
  }

  onModuleInit() {
    if (this.db) return;
    const url = this.config.get('databaseUrl', { infer: true });
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(
      new URL(url).hostname,
    );
    this.client = postgres(url, {
      // Transaction-mode poolers (Supavisor :6543) do not support prepared statements.
      prepare: false,
      max:
        this.config.get('env', { infer: true }) === NodeEnv.Production ? 10 : 5,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: isLocal ? false : 'require',
    });
    this.db = drizzle(this.client, { schema: dbSchema });
  }

  async onModuleDestroy() {
    await this.client?.end({ timeout: 5 });
  }

  /** Runs `fn` in a transaction acting as `userId`. `userId` MUST come from a verified token, never from input. */
  withUser<T>(userId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return withUserContext(this.db, userId, fn);
  }

  /** Runs `fn` as the request role with no identity (public storefront / branding only). */
  withPublic<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return withPublicContext(this.db, fn);
  }

  async ping(): Promise<boolean> {
    try {
      await this.withPublic(async (tx) => {
        await tx.execute(sql`select 1`);
      });
      return true;
    } catch (error) {
      this.logger.error(
        `database ping failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
  }

  static rows = rowsOf;
}
