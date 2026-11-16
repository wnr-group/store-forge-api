import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import {
  forbidden,
  unauthenticated,
} from '../../common/errors/app-exception.js';
import { DatabaseService } from '../database/database.service.js';
import { IS_PUBLIC_KEY, REQUIRE_PLATFORM_ADMIN_KEY } from './decorators.js';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requirePlatformAdmin = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_PLATFORM_ADMIN_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requirePlatformAdmin) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth || !auth.userId) {
      throw unauthenticated('Invalid or expired session.');
    }

    // Call public.is_platform_admin() through DatabaseService.withUser (AC-B-79)
    const isAdmin = await this.database.withUser(auth.userId, async (tx) => {
      const res = await tx.execute<{ is_admin: boolean }>(
        sql`select public.is_platform_admin() as is_admin`,
      );
      return res[0]?.is_admin === true;
    });

    if (!isAdmin) {
      throw forbidden('Platform admin authorization required.');
    }

    return true;
  }
}
