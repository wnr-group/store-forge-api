import {
  accessEntries,
  can,
  canManagePayments,
  presetOf,
  roleLabel,
  ROLE_PRESETS,
  type Actor,
  type Permission,
} from './permissions.js';

const owner: Actor = { role: 'owner', permissions: {} };
const member = (permissions: Actor['permissions']): Actor => ({
  role: 'admin',
  permissions,
});

const ALL: Permission[] = [
  'dashboard:view',
  'store:manage',
  'store:delete',
  'tenant:manage',
  'tenant:delete',
  'members:manage',
  'catalog:view',
  'catalog:manage',
  'catalog:delete',
  'orders:view',
  'customers:view',
  'customers:manage',
  'customers:delete',
  'payments:manage',
];

describe('permission rules (ported from lib/auth/permissions.ts)', () => {
  it('the Owner may do everything, regardless of the stored permissions', () => {
    for (const p of ALL) expect(can(owner, p), p).toBe(true);
  });

  it.each(Object.entries(ROLE_PRESETS))('%s preset', (_key, preset) => {
    const a = member(preset.permissions);
    expect(can(a, 'dashboard:view')).toBe(true);
    expect(can(a, 'catalog:view')).toBe(true);
    expect(can(a, 'orders:view')).toBe(true);
    // Members never manage the team or delete the store / organization.
    for (const p of [
      'members:manage',
      'store:delete',
      'tenant:delete',
    ] as const)
      expect(can(a, p), p).toBe(false);
  });

  it('Manager and Staff write the catalog and customers; Viewer only reads', () => {
    const manager = member(ROLE_PRESETS.manager.permissions);
    const staff = member(ROLE_PRESETS.staff.permissions);
    const viewer = member(ROLE_PRESETS.viewer.permissions);
    for (const a of [manager, staff]) {
      expect(can(a, 'catalog:manage')).toBe(true);
      expect(can(a, 'catalog:delete')).toBe(true);
      expect(can(a, 'customers:manage')).toBe(true);
    }
    expect(can(manager, 'store:manage')).toBe(true);
    expect(can(staff, 'store:manage')).toBe(false); // settings: read
    expect(can(viewer, 'catalog:manage')).toBe(false);
    expect(can(viewer, 'customers:manage')).toBe(false);
    expect(can(viewer, 'catalog:view')).toBe(true);
  });

  it('a member with no access to a module is refused even to read it', () => {
    const a = member({
      products: 'none',
      orders: 'none',
      customers: 'none',
      settings: 'read',
    });
    expect(can(a, 'catalog:view')).toBe(false);
    expect(can(a, 'orders:view')).toBe(false);
    expect(can(a, 'customers:view')).toBe(false);
  });

  it('store settings are never below read, even when missing', () => {
    const a = member({});
    expect(can(a, 'store:manage')).toBe(false);
    expect(accessEntries('admin', {})).toEqual([
      { module: 'settings', label: 'Store settings', level: 'read' },
    ]);
  });

  it('read does not imply write, write implies read', () => {
    expect(can(member({ products: 'read' }), 'catalog:manage')).toBe(false);
    expect(can(member({ products: 'write' }), 'catalog:view')).toBe(true);
  });

  it('labels roles from the stored permissions only', () => {
    expect(roleLabel('owner', {})).toBe('Owner');
    expect(roleLabel('admin', ROLE_PRESETS.manager.permissions)).toBe(
      'Manager',
    );
    expect(roleLabel('admin', ROLE_PRESETS.staff.permissions)).toBe('Staff');
    expect(roleLabel('admin', ROLE_PRESETS.viewer.permissions)).toBe('Viewer');
    expect(roleLabel('admin', { products: 'write' })).toBe('Custom');
    expect(
      presetOf({
        products: 'write',
        orders: 'read',
        customers: 'write',
        settings: 'write',
      }),
    ).toBe('manager');
  });
});

describe("payments:manage (AC-PERM-01): the Owner's payment credentials", () => {
  it('is Owner-only', () => {
    expect(can(owner, 'payments:manage')).toBe(true);
    expect(canManagePayments(owner)).toBe(true);
  });

  it('is refused to every preset, however much access the Owner granted', () => {
    for (const preset of Object.values(ROLE_PRESETS))
      expect(can(member(preset.permissions), 'payments:manage')).toBe(false);
  });

  it('cannot be reached by granting module access, including write on store settings', () => {
    const everything: Actor['permissions'] = {
      products: 'write',
      orders: 'read',
      customers: 'write',
      settings: 'write',
    };
    expect(can(member(everything), 'payments:manage')).toBe(false);
    expect(can(member(everything), 'store:manage')).toBe(true); // the contrast
    expect(canManagePayments(member(everything))).toBe(false);
    expect(can(member({}), 'payments:manage')).toBe(false);
  });

  it('is not implied by the store-settings permissions', () => {
    const settingsWriter = member({ settings: 'write' });
    expect(can(settingsWriter, 'tenant:manage')).toBe(true);
    expect(can(settingsWriter, 'payments:manage')).toBe(false);
  });
});
