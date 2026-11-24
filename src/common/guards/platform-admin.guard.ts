import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { AppException, forbidden } from '../app.exception.js';
import {
  FULL_ACCESS_PLATFORM_ROLES,
  isPlatformRole,
  platformCan,
} from '../constants/platform-permissions.js';
import {
  PLATFORM_ACCESS,
  type PlatformAccessOptions,
} from '../decorators/decorators.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import type {
  AuthenticatedRequest,
  PlatformLevel,
} from '../interfaces/request-context.js';

/** Per admin, per window. Same numbers as lib/security/rate-limit.ts. */
export const ADMIN_RATE_LIMITS = {
  'org.create': { limit: 10, windowSeconds: 600 },
  'org.delete': { limit: 5, windowSeconds: 600 },
  'org.edit': { limit: 60, windowSeconds: 600 },
  'team.manage': { limit: 30, windowSeconds: 600 },
  'ownership.change': { limit: 5, windowSeconds: 600 },
  'admin.manage': { limit: 10, windowSeconds: 600 },
  'settings.update': { limit: 20, windowSeconds: 600 },
  'plan.manage': { limit: 60, windowSeconds: 600 },
  'subscription.manage': { limit: 60, windowSeconds: 600 },
} as const;

type Hit = { allowed: boolean; remaining: number; retry_after_seconds: number };

/** "about 45 seconds" / "about 8 minutes" */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 90
    ? `${s} second${s === 1 ? '' : 's'}`
    : `${Math.ceil(s / 60)} minutes`;
}

/**
 * Platform Admin authorisation, entirely separate from tenant roles. The answer comes from the database
 * (`public.platform_admin_role()`, which reads only the authenticated user id and the privately managed
 * `platform_admins` table), never from token claims, user metadata or anything the client sends.
 *
 * Mutating routes also count one attempt against a per-admin bucket (`rate_limit_admin`) BEFORE the operation
 * runs. If the limiter itself is unreachable the request is allowed and the problem logged, exactly as today.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<
      PlatformAccessOptions | undefined
    >(PLATFORM_ACCESS, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user.id;

    const level: PlatformLevel | null = await this.db.withUser(
      userId,
      async (tx) => {
        const rows = rowsOf<{ r: string | null }>(
          await tx.execute(sql`select public.platform_admin_role() as r`),
        );
        const role = rows[0]?.r;
        return isPlatformRole(role) ? role : null;
      },
    );
    if (!level) throw forbidden();
    if (options.level === 'super_admin' && level !== 'super_admin')
      throw forbidden(
        'Only a super admin can do that.',
        'SUPER_ADMIN_REQUIRED',
      );
    if (options.permission) {
      if (!platformCan(level, options.permission))
        throw forbidden(
          'Your platform role does not allow that.',
          'PLATFORM_PERMISSION_REQUIRED',
        );
    } else if (
      !options.anyStaff &&
      !FULL_ACCESS_PLATFORM_ROLES.includes(level)
    ) {
      // A route that never declared a permission predates the narrower roles: keep it closed to them.
      throw forbidden(
        'Your platform role does not allow that.',
        'PLATFORM_PERMISSION_REQUIRED',
      );
    }
    request.platformLevel = level;

    if (options.bucket) await this.enforceRateLimit(userId, options.bucket);
    return true;
  }

  private async enforceRateLimit(
    userId: string,
    bucket: keyof typeof ADMIN_RATE_LIMITS,
  ) {
    const { limit, windowSeconds } = ADMIN_RATE_LIMITS[bucket];
    let hit: Hit | undefined;
    try {
      hit = await this.db.withUser(
        userId,
        async (tx) =>
          rowsOf<Hit>(
            await tx.execute(
              sql`select * from public.rate_limit_admin(${bucket}, ${limit}, ${windowSeconds})`,
            ),
          )[0],
      );
    } catch (error) {
      this.logger.error(
        `rate limiter unavailable for ${bucket}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return;
    }
    if (hit && !hit.allowed) {
      this.logger.warn(
        `rate limited ${bucket}: retry after ${hit.retry_after_seconds}s`,
      );
      throw new AppException(
        'RATE_LIMITED',
        `Too many requests. Please wait about ${waitText(hit.retry_after_seconds)} and try again.`,
      );
    }
  }
}
