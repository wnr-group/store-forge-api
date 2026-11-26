/**
 * Platform-level access, deliberately separate from tenant roles (`permissions.ts`). A tenant Owner never holds any of
 * these. The role itself is read from `platform_admins` by the database (`platform_admin_role()`); this file only says
 * what each platform role may do, and is the single place the guard consults.
 */
import {
  PLATFORM_ADMIN_ROLES,
  type PlatformAdminRole,
} from '../../database/schema/enums.js';

export const PLATFORM_PERMISSIONS = [
  'tenants:read',
  'tenants:manage',
  'plans:read',
  'plans:manage',
  'subscriptions:read',
  'subscriptions:manage',
  /** Feature entitlements and usage limits, plan-level and per-tenant overrides. */
  'entitlements:manage',
  'usage:read',
  'billing:read',
  'billing:manage',
  'audit:read',
  'monitoring:read',
  'admins:read',
  'admins:manage',
  'settings:read',
  'settings:manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const without = (...excluded: PlatformPermission[]): PlatformPermission[] =>
  PLATFORM_PERMISSIONS.filter((p) => !excluded.includes(p));

/**
 * Role -> permissions. `admin` (shown as "Platform Admin") keeps everything it could do before the roles existed, minus
 * what has always been super-admin only. Billing and Support admins start from nothing and are granted read access
 * to what they need, so a new route is closed to them until someone opts it in.
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<
  PlatformAdminRole,
  readonly PlatformPermission[]
> = {
  super_admin: PLATFORM_PERMISSIONS,
  admin: without('admins:manage', 'settings:manage', 'billing:manage'),
  billing_admin: [
    'tenants:read',
    'plans:read',
    'subscriptions:read',
    'usage:read',
    'billing:read',
    'billing:manage',
    'settings:read',
  ],
  support_admin: [
    'tenants:read',
    'subscriptions:read',
    'usage:read',
    'settings:read',
  ],
};

export const PLATFORM_ROLE_LABELS: Record<PlatformAdminRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Platform Admin',
  billing_admin: 'Billing Admin',
  support_admin: 'Support Admin',
};

export function isPlatformRole(value: unknown): value is PlatformAdminRole {
  return (
    typeof value === 'string' &&
    (PLATFORM_ADMIN_ROLES as readonly string[]).includes(value)
  );
}

export const platformCan = (
  role: PlatformAdminRole,
  permission: PlatformPermission,
): boolean => PLATFORM_ROLE_PERMISSIONS[role].includes(permission);

/** Roles that may use routes which declare no permission (everything that existed before the roles were added). */
export const FULL_ACCESS_PLATFORM_ROLES: readonly PlatformAdminRole[] = [
  'super_admin',
  'admin',
];
