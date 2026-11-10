import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import { waitText } from '../../common/guards/platform-admin.guard.js';
import type { AppConfig } from '../../config/configuration.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';

type Hit = { allowed: boolean; remaining: number; retry_after_seconds: number };

/**
 * Sign-in attempt limiting (port of lib/security/rate-limit.ts). Counters live in the database
 * (`rate_limit_login`), so every API instance shares them. Two buckets per attempt: this address + e-mail, and this
 * address alone (8 and 40 per 15 minutes, enforced by the SQL function). Only keyed hashes are ever stored, never
 * an address or e-mail. The attempt is counted BEFORE the password is checked.
 *
 * If the limiter itself is unreachable the sign-in is allowed and the problem logged: a limiter fault must not lock
 * everyone out. Supabase applies its own limits as well.
 */
@Injectable()
export class LoginRateLimitService {
  private readonly logger = new Logger(LoginRateLimitService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  subjects(address: string, email: string): { email: string; ip: string } {
    const { rateLimitSecret } = this.config.get('auth', { infer: true });
    const secret =
      rateLimitSecret ||
      this.config.get('supabase', { infer: true }).serviceRoleKey;
    const hmac = (value: string) =>
      createHmac('sha256', secret).update(value).digest('hex');
    const ip = address.trim().toLowerCase() || 'unknown';
    return { email: hmac(`${ip}|${email.trim().toLowerCase()}`), ip: hmac(ip) };
  }

  async enforce(address: string, email: string): Promise<void> {
    let worst: Hit | undefined;
    try {
      const subjects = this.subjects(address, email);
      const hits = await this.db.withPublic(async (tx) => {
        const byEmail = rowsOf<Hit>(
          await tx.execute(
            sql`select * from public.rate_limit_login(${subjects.email}, 'email')`,
          ),
        )[0];
        const byIp = rowsOf<Hit>(
          await tx.execute(
            sql`select * from public.rate_limit_login(${subjects.ip}, 'ip')`,
          ),
        )[0];
        return [byEmail, byIp];
      });
      worst = hits
        .filter((h): h is Hit => Boolean(h) && !h!.allowed)
        .sort((a, b) => b.retry_after_seconds - a.retry_after_seconds)[0];
    } catch (error) {
      this.logger.error(
        `login rate limiter unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return;
    }
    if (worst) {
      this.logger.warn(
        `login rate limited, retry after ${worst.retry_after_seconds}s`,
      );
      throw new AppException(
        'RATE_LIMITED',
        `Too many requests. Please wait about ${waitText(worst.retry_after_seconds)} and try again.`,
        { code: 'LOGIN_RATE_LIMITED' },
      );
    }
  }
}
