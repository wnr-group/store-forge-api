import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  unauthenticated,
  validationFailed,
} from '../../common/errors/app-exception.js';
import { IS_PUBLIC_KEY, NO_TENANT_KEY } from './decorators.js';
import { TenantAccessService } from './tenant-access.service.js';

const STRICT_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantAccessService: TenantAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const noTenant = this.reflector.getAllAndOverride<boolean>(NO_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (noTenant) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth || !auth.userId) {
      throw unauthenticated('Missing or malformed Authorization header.');
    }

    // Tenant header validation (AC-B-24, AC-B-25, AC-B-32)
    // Only X-Tenant-Id is inspected; body, query and JWT claims are ignored
    const rawTenantId = request.headers['x-tenant-id'];

    if (!rawTenantId || typeof rawTenantId !== 'string') {
      throw validationFailed('Missing X-Tenant-Id header.');
    }

    if (!STRICT_LOWERCASE_UUID.test(rawTenantId) || rawTenantId === NIL_UUID) {
      throw validationFailed(
        'Invalid X-Tenant-Id header: must be a lowercase non-nil UUID.',
      );
    }

    const tenantContext = await this.tenantAccessService.resolve(
      auth.userId,
      rawTenantId,
    );
    request.tenant = tenantContext;

    return true;
  }
}
