import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { AppConfig } from '../../config/configuration.js';
import { dbSchema, type Database, type DbTx } from './database.types.js';
import { withPublicContext, withUserContext } from './user-context.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private client: ReturnType<typeof postgres> | null = null;
  private db: Database | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  async onModuleInit(): Promise<void> {
    const dbConfig = this.configService.get('database', { infer: true });
    if (!dbConfig?.url) {
      this.logger.warn(
        'DATABASE_URL not configured; database client not started.',
      );
      return;
    }

    try {
      this.initClient(dbConfig.url, {
        prepare: dbConfig.prepare,
        max: dbConfig.poolMax,
        connectTimeout: dbConfig.connectTimeoutSeconds,
      });

      const timeoutMs = 3000;
      const isHealthy = await this.ping(timeoutMs);
      if (!isHealthy) {
        this.logger.warn(
          'Initial database ping failed; service will retry on request.',
        );
      }
    } catch {
      this.logger.warn('Failed to initialize database client during startup.');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client) {
      await this.client.end({ timeout: 5 });
      this.client = null;
      this.db = null;
    }
  }

  /**
   * Internal initialization helper.
   */
  initClient(
    url: string,
    options?: { prepare?: boolean; max?: number; connectTimeout?: number },
  ): void {
    let isLocal = false;
    try {
      const hostname = new URL(url).hostname;
      isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    } catch {
      // Ignore URL parse error; postgres() will handle validation
    }

    this.client = postgres(url, {
      prepare: options?.prepare ?? false,
      max: options?.max ?? 5,
      idle_timeout: 20,
      connect_timeout: options?.connectTimeout ?? 10,
      ssl: isLocal ? false : 'require',
    });

    this.db = drizzle(this.client, { schema: dbSchema });
  }

  /**
   * For testing: allows replacing the client and drizzle database instance.
   */
  setDatabase(db: Database, client?: ReturnType<typeof postgres>): void {
    this.db = db;
    if (client) {
      this.client = client;
    }
  }

  getDatabase(): Database {
    if (!this.db) {
      throw new Error('Database is not initialized.');
    }
    return this.db;
  }

  getClient(): ReturnType<typeof postgres> | null {
    return this.client;
  }

  /**
   * Runs `fn` inside a transaction as the verified user `userId`.
   */
  async withUser<T>(userId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const db = this.getDatabase();
    return withUserContext(db, userId, fn);
  }

  /**
   * Runs `fn` inside a public storefront transaction with no user claims.
   */
  async withPublic<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const db = this.getDatabase();
    return withPublicContext(db, fn);
  }

  /**
   * Select 1 and role-safety check. Never throws; returns false on any failure or timeout.
   */
  async ping(timeoutMs: number): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });

      const checkPromise = this.client.unsafe<
        {
          ok: number;
          bad_roles: string[] | null;
        }[]
      >(`
        select 1 as ok,
          (select array_agg(rolname) from pg_roles
            where rolname in (current_user, session_user) and (rolsuper or rolbypassrls)) as bad_roles
      `);

      const result = await Promise.race([checkPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      const row = result?.[0];
      if (!row || row.ok !== 1) {
        return false;
      }
      if (row.bad_roles && row.bad_roles.length > 0) {
        return false;
      }
      return true;
    } catch {
      if (timer) clearTimeout(timer);
      this.logger.warn('Database ping check failed');
      return false;
    }
  }
}
