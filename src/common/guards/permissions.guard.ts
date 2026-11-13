import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden } from '../app.exception.js';
import { can, type Permission } from '../constants/permissions.js';
import { REQUIRED_PERMISSION } from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';

/**
 * Evaluates `@RequirePermission()` with the same rules as the Next.js app (`can(actor, permission)`).
 * The database enforces the same rules through RLS; this guard gives a clean 403 first.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return true;
    const org = context.switchToHttp().getRequest<AuthenticatedRequest>().org;
    if (
      !org ||
      !can({ role: org.role, permissions: org.permissions }, permission)
    )
      throw forbidden();
    return true;
  }
}
