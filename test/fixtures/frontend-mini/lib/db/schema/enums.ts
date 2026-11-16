export const STORE_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'staff'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MODULES = [
  'products',
  'orders',
  'customers',
  'settings',
] as const;
export type Module = (typeof MODULES)[number];
export const ACCESS_LEVELS = ['none', 'read', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type MemberPermissions = Partial<Record<Module, AccessLevel>>;

