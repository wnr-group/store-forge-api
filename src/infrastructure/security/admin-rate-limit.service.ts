import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AppException,
  rateLimited,
} from '../../common/errors/app-exception.js';
import type { DbTx } from '../database/database.types.js';

export const ADMIN_RATE_LIMIT_WINDOW_SECONDS = 600;

export const ADMIN_RATE_LIMITS: Record<
  string,
  { limit: number; windowSeconds: number }
> = {
  'org.create': { limit: 10, windowSeconds: 600 },
  'org.edit': { limit: 60, windowSeconds: 600 },
  'org.delete': { limit: 5, windowSeconds: 600 },
  'team.manage': { limit: 30, windowSeconds: 600 },
  'ownership.change': { limit: 5, windowSeconds: 600 },
  'admin.manage': { limit: 10, windowSeconds: 600 },
  'settings.update': { limit: 20, windowSeconds: 600 },
};

@Injectable()
export class AdminRateLimitService {
  private readonly logger = new Logger(AdminRateLimitService.name);

  /**
   * Enforces platform admin rate limits for mutations using public.rate_limit_admin (AC-B-73 to AC-B-75).
   * Throws 429 RATE_LIMITED when the limit is exceeded.
   * Fails open with a server log on any unexpected database or limiter error.
   */
  async enforce(tx: DbTx, bucket: string): Promise<void> {
    const config = ADMIN_RATE_LIMITS[bucket];
    if (!config) {
      this.logger.warn(`Unknown admin rate limit bucket: ${bucket}`);
      return;
    }

    try {
      const rows = await tx.execute<{
        allowed: boolean;
        remaining: number;
        retry_after_seconds: number;
      }>(
        sql`select * from public.rate_limit_admin(${bucket}, ${config.limit}, ${config.windowSeconds})`,
      );

      const result = rows[0];
      if (result && !result.allowed) {
        throw rateLimited(
          `Platform admin rate limit exceeded for ${bucket}. Try again in ${result.retry_after_seconds}s.`,
        );
      }
    } catch (err) {
      if (err instanceof AppException && err.getStatus() === 429) {
        throw err;
      }
      this.logger.error(
        `Admin rate limiter error, failing open: ${String(err)}`,
      );
    }
  }
}
