import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  forbidden,
  unauthenticated,
} from '../../common/errors/app-exception.js';
import { IS_PUBLIC_KEY, REQUIRE_PERMISSION_KEY } from './decorators.js';
import { can, type Permission } from './generated/permissions.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermission = this.reflector.getAllAndOverride<string>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;
    if (!auth || !auth.userId) {
      throw unauthenticated('Missing or malformed Authorization header.');
    }

    const tenant = request.tenant;
    if (!tenant) {
      throw forbidden('Access to tenant denied.');
    }

    const actor = {
      role: tenant.role,
      permissions: tenant.permissions,
    };

    if (!can(actor, requiredPermission as Permission)) {
      throw forbidden('Permission denied.');
    }

    return true;
  }
}
