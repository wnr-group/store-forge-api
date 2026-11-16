import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser, TenantContext } from './auth.types.js';

export const IS_PUBLIC_KEY = 'isPublic';
export const NO_TENANT_KEY = 'noTenant';
export const REQUIRE_PLATFORM_ADMIN_KEY = 'requirePlatformAdmin';
export const REQUIRE_SUPER_ADMIN_KEY = 'requireSuperAdmin';
export const REQUIRE_PERMISSION_KEY = 'requirePermission';
export const REQUIRE_LIVE_AUTH_KEY = 'requireLiveAuth';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);
export const RequirePlatformAdmin = () =>
  SetMetadata(REQUIRE_PLATFORM_ADMIN_KEY, true);
export const RequireSuperAdmin = () =>
  SetMetadata(REQUIRE_SUPER_ADMIN_KEY, true);
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
export const RequireLiveAuth = () => SetMetadata(REQUIRE_LIVE_AUTH_KEY, true);

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.auth;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);

export const CurrentTenant = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const tenant = request.tenant;
    if (!tenant) return undefined;
    return data ? tenant[data] : tenant;
  },
);

export { expectLiveAuthRequired } from './live-auth.helper.js';
