/**
 * Allowed values for text+CHECK "enum" columns. Kept dependency-free so both
 * the Drizzle schema and the RBAC module can import it. The database enforces
 * the same sets with CHECK constraints (see schema files).
 */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'staff'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Modules an Owner can grant to a team member, with the level each one takes. `write` always includes `read`.
 * The database enforces this with restrictive RLS policies calling has_module_access() (0018_member_permissions).
 */
export const MODULES = [
  'products',
  'orders',
  'customers',
  'settings',
  'design',
] as const;
export type Module = (typeof MODULES)[number];
/** `publish` exists for the `design` module only (publish implies write implies read). */
export const ACCESS_LEVELS = ['none', 'read', 'write', 'publish'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type MemberPermissions = Partial<Record<Module, AccessLevel>>;

/** Independent grants stored on the membership (memberships.capabilities). They are not levels and do not imply one. */
export const MEMBER_CAPABILITIES = ['attest', 'discard'] as const;
export type MemberCapability = (typeof MEMBER_CAPABILITIES)[number];

/**
 * Platform staff roles. Only a super admin can manage other admins and the platform settings; the last one can never be
 * removed. `admin` is shown as "Platform Admin". What each role may do: common/constants/platform-permissions.ts.
 */
export const PLATFORM_ADMIN_ROLES = [
  'super_admin',
  'admin',
  'billing_admin',
  'support_admin',
] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

/** A deactivated membership keeps its row but grants no access (enforced by is_tenant_member / has_tenant_role). */
export const MEMBERSHIP_STATUSES = ['active', 'disabled'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A suspended company is invisible to all of its members at the database level. */
export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const STORE_STATUSES = ['active', 'inactive', 'suspended'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** Shared by tenants.slug and stores.slug (also enforced by is_valid_store_slug()). */
export const SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$';

export const PRODUCT_STATUSES = ['draft', 'active'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const COLLECTION_STATUSES = ['draft', 'active'] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const INVENTORY_REASONS = [
  'restock',
  'correction',
  'return',
  'damage',
  'sale',
  'other',
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

/** The order lifecycle. Moves between them are restricted: see modules/orders/order-state.ts. */
export const ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'processing',
  'ready_to_ship',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'failed',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Order statuses that count as revenue in analytics and customer totals. */
export const REVENUE_ORDER_STATUSES = [
  'confirmed',
  'processing',
  'ready_to_ship',
  'shipped',
  'out_for_delivery',
  'delivered',
] as const satisfies readonly OrderStatus[];

export const ORDER_PAYMENT_METHODS = ['razorpay', 'cod'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const ORDER_PAYMENT_STATUSES = [
  'unpaid',
  'pending_collection',
  'paid',
  'collected',
  'failed',
  'partially_refunded',
  'refunded',
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const ORDER_FULFILLMENT_STATUSES = [
  'unfulfilled',
  'partial',
  'fulfilled',
  'returned',
] as const;
export type OrderFulfillmentStatus =
  (typeof ORDER_FULFILLMENT_STATUSES)[number];

/** Same shape as SLUG_PATTERN but allows the 1-char-per-end minimum used for catalog slugs (2-80 chars). */
export const CATALOG_SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
