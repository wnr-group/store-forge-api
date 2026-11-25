import { describe, expect, it } from 'vitest';
import { PLATFORM_ADMIN_ROLES } from '../../database/schema/enums.js';
import {
  FULL_ACCESS_PLATFORM_ROLES,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_LABELS,
  PLATFORM_ROLE_PERMISSIONS,
  isPlatformRole,
  platformCan,
} from './platform-permissions.js';

describe('platform permissions', () => {
  it('defines a permission set and a label for every platform role', () => {
    for (const role of PLATFORM_ADMIN_ROLES) {
      expect(PLATFORM_ROLE_PERMISSIONS[role]).toBeDefined();
      expect(PLATFORM_ROLE_LABELS[role]).toBeTruthy();
    }
  });

  it('gives the super admin every permission', () => {
    for (const p of PLATFORM_PERMISSIONS)
      expect(platformCan('super_admin', p)).toBe(true);
  });

  it('keeps admin management, settings changes and billing changes away from the Platform Admin', () => {
    expect(platformCan('admin', 'tenants:manage')).toBe(true);
    expect(platformCan('admin', 'plans:manage')).toBe(true);
    expect(platformCan('admin', 'entitlements:manage')).toBe(true);
    expect(platformCan('admin', 'admins:manage')).toBe(false);
    expect(platformCan('admin', 'settings:manage')).toBe(false);
    expect(platformCan('admin', 'billing:manage')).toBe(false);
  });

  it('limits Billing and Support admins to what they need', () => {
    expect(platformCan('billing_admin', 'billing:manage')).toBe(true);
    expect(platformCan('billing_admin', 'tenants:manage')).toBe(false);
    expect(platformCan('billing_admin', 'audit:read')).toBe(false);
    expect(platformCan('support_admin', 'tenants:read')).toBe(true);
    expect(platformCan('support_admin', 'billing:read')).toBe(false);
    for (const p of PLATFORM_PERMISSIONS.filter((x) => x.endsWith(':manage')))
      expect(platformCan('support_admin', p)).toBe(false);
  });

  it('only lets the super admin and the Platform Admin through routes with no declared permission', () => {
    expect([...FULL_ACCESS_PLATFORM_ROLES]).toEqual(['super_admin', 'admin']);
  });

  it('recognises only real roles', () => {
    expect(isPlatformRole('billing_admin')).toBe(true);
    expect(isPlatformRole('owner')).toBe(false);
    expect(isPlatformRole(null)).toBe(false);
  });
});
