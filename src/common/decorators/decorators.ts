import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Permission } from '../constants/permissions.js';
import type { FeatureKey } from '../constants/plan-catalog.js';
import type { PlatformPermission } from '../constants/platform-permissions.js';
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

export const REQUIRE_EXPLICIT_ORG = 'requireExplicitOrg';
/**
 * Opt-in, for routes where acting on the wrong organization would be costly and silent (payment credentials). The
 * `X-Organization-Id` header must be present and non-blank; without it the request is refused with 400
 * ORGANIZATION_REQUIRED instead of falling back to the caller's first organization. The header is still verified
 * against the caller's memberships. Routes without this decorator behave exactly as before.
 */
export const RequireExplicitOrganization = () =>
  SetMetadata(REQUIRE_EXPLICIT_ORG, true);

export const REQUIRED_PERMISSION = 'requiredPermission';
/** Requires `can(actor, permission)` (same rules as the Next.js `lib/auth/permissions.ts`). Implies a resolved organization. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

export interface PlatformAccessOptions {
  /** `super_admin` for operations only a super admin may perform. Default: any Platform Admin. */
  level?: 'admin' | 'super_admin';
  /**
   * The platform permission this route needs (see platform-permissions.ts). A route with neither `permission`, `level` nor
   * `anyStaff` is limited to the full-access roles (super_admin, admin), so Billing and Support admins never reach a
   * route that has not explicitly opted them in.
   */
  permission?: PlatformPermission;
  /** Any platform role may call this (identity and navigation only, e.g. "who am I"). */
  anyStaff?: boolean;
  /** Per-admin rate-limit bucket (database counters), counted before the operation runs. */
  bucket?:
    | 'org.create'
    | 'org.delete'
    | 'org.edit'
    | 'team.manage'
    | 'ownership.change'
    | 'admin.manage'
    | 'settings.update'
    | 'plan.manage'
    | 'subscription.manage'
    | 'billing.manage';
}
export const PLATFORM_ACCESS = 'platformAccess';
/** Platform Admin only. Answered by the database (`platform_admin_role()`), never by token claims or the request. */
export const PlatformAccess = (options: PlatformAccessOptions = {}) =>
  SetMetadata(PLATFORM_ACCESS, options);

export const REQUIRED_FEATURE = 'requiredFeature';
/**
 * The organization's plan must include this feature (see plan-catalog.ts), or the request is refused with 403 before the handler runs
 * (FeatureGuard). Needs an organization-scoped route. Services that cannot use the decorator call EntitlementsService themselves.
 */
export const RequireFeature = (feature: FeatureKey) =>
  SetMetadata(REQUIRED_FEATURE, feature);

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
