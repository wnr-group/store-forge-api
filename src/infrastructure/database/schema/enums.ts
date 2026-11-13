// GENERATED from wnr-group/store-forge lib/db/schema/enums.ts. DO NOT EDIT.

/**
 * Allowed values for text+CHECK "enum" columns. Kept dependency-free so both
 * the Drizzle schema and the RBAC module can import it. The database enforces
 * the same sets with CHECK constraints (see schema files).
 */
export const MEMBERSHIP_ROLES = ["owner", "admin", "staff"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Modules an Owner can grant to a team member, with the level each one takes. `write` always includes `read`.
 * The database enforces this with restrictive RLS policies calling has_module_access() (0018_member_permissions).
 */
export const MODULES = ["products", "orders", "customers", "settings"] as const;
export type Module = (typeof MODULES)[number];
export const ACCESS_LEVELS = ["none", "read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type MemberPermissions = Partial<Record<Module, AccessLevel>>;

/** Platform staff levels. Only a super admin can manage other admins and the platform settings; the last one can never be removed. */
export const PLATFORM_ADMIN_ROLES = ["super_admin", "admin"] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

/** A deactivated membership keeps its row but grants no access (enforced by is_tenant_member / has_tenant_role). */
export const MEMBERSHIP_STATUSES = ["active", "disabled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A suspended company is invisible to all of its members at the database level. */
export const TENANT_STATUSES = ["active", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const STORE_STATUSES = ["active", "inactive", "suspended"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** Shared by tenants.slug and stores.slug (also enforced by is_valid_store_slug()). */
export const SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$";

export const PRODUCT_STATUSES = ["draft", "active"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const COLLECTION_STATUSES = ["draft", "active"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const INVENTORY_REASONS = ["restock", "correction", "return", "damage", "sale", "other"] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Order statuses that count as revenue in analytics and customer totals. */
export const REVENUE_ORDER_STATUSES = ["paid", "fulfilled"] as const satisfies readonly OrderStatus[];

/** Same shape as SLUG_PATTERN but allows the 1-char-per-end minimum used for catalog slugs (2-80 chars). */
export const CATALOG_SLUG_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";
