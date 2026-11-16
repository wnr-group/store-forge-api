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
import { IS_PUBLIC_KEY, REQUIRE_SUPER_ADMIN_KEY } from './decorators.js';

@Injectable()
export class SuperAdminGuard implements CanActivate {
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

    const requireSuperAdmin = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_SUPER_ADMIN_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requireSuperAdmin) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth || !auth.userId) {
      throw unauthenticated('Invalid or expired session.');
    }

    // Call public.platform_admin_role() through DatabaseService.withUser (AC-B-80)
    const isSuper = await this.database.withUser(auth.userId, async (tx) => {
      const res = await tx.execute<{ role: string | null }>(
        sql`select public.platform_admin_role() as role`,
      );
      return res[0]?.role === 'super_admin';
    });

    if (!isSuper) {
      throw forbidden('Super admin authorization required.');
    }

    return true;
  }
}
