import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Permission } from '../constants/permissions.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';

export const IS_PUBLIC = 'isPublic';
/** Opts a route out of the global Supabase JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CSRF_PROTECTED = 'csrfProtected';
/**
 * The route signs in, out or refreshes the cookie session, so even a request without a cookie must prove its origin
 * (a browser origin from the allowlist, or the trusted frontend server's shared secret). See CsrfGuard.
 */
export const CsrfProtected = () => SetMetadata(CSRF_PROTECTED, true);

export const ORG_SCOPED = 'orgScoped';
/**
 * The route works on one organization's data. The OrganizationContextGuard resolves the caller's membership from
 * Postgres (the `X-Organization-Id` header is only a hint, verified against memberships) and attaches it.
 */
export const OrgScoped = () => SetMetadata(ORG_SCOPED, true);

export const REQUIRED_PERMISSION = 'requiredPermission';
/** Requires `can(actor, permission)` (same rules as the Next.js `lib/auth/permissions.ts`). Implies a resolved organization. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

export interface PlatformAccessOptions {
  /** `super_admin` for operations only a super admin may perform. Default: any Platform Admin. */
  level?: 'admin' | 'super_admin';
  /** Per-admin rate-limit bucket (database counters), counted before the operation runs. */
  bucket?:
    | 'org.create'
    | 'org.delete'
    | 'org.edit'
    | 'team.manage'
    | 'ownership.change'
    | 'admin.manage'
    | 'settings.update';
}
export const PLATFORM_ACCESS = 'platformAccess';
/** Platform Admin only. Answered by the database (`platform_admin_role()`), never by token claims or the request. */
export const PlatformAccess = (options: PlatformAccessOptions = {}) =>
  SetMetadata(PLATFORM_ACCESS, options);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const org = ctx.switchToHttp().getRequest<AuthenticatedRequest>().org;
    if (!org)
      throw new Error('CurrentOrg used on a route without @OrgScoped()');
    return org;
  },
);

export const CurrentPlatformLevel = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().platformLevel,
);
