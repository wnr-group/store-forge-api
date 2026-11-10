export const STORE_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];
