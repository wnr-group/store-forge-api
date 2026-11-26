import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users.js';
import { collections, products } from './catalog.js';
import { customers, orders } from './customers.js';
import { tenants } from './tenants.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const minor = (name: string) => bigint(name, { mode: 'number' });
const stamp = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();
const actor = (name: string) =>
  uuid(name).references(() => authUsers.id, { onDelete: 'set null' });

export const CAMPAIGN_STATUSES = [
  'draft',
  'active',
  'paused',
  'completed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** A promotional campaign (migration 0053). `channels` is reserved for future email / SMS sends; nothing reads it yet. */
export const promotionalCampaigns = pgTable(
  'promotional_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: CAMPAIGN_STATUSES })
      .notNull()
      .default('draft'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    channels: jsonb('channels')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: stamp('created_at'),
    createdBy: actor('created_by'),
    updatedAt: stamp('updated_at'),
    updatedBy: actor('updated_by'),
  },
  (t) => [
    unique('pc_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('pc_tenant_name_key').on(t.tenantId, sql`lower(${t.name})`),
    index('pc_tenant_status_idx').on(t.tenantId, t.status, t.createdAt.desc()),
    check(
      'pc_status_check',
      sql`${t.status} in ('draft', 'active', 'paused', 'completed')`,
    ),
    check(
      'pc_window_check',
      sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`,
    ),
  ],
).enableRLS();

/** The products or collections a campaign covers: exactly one of `productId` / `collectionId` per row. */
export const campaignTargets = pgTable(
  'campaign_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    productId: uuid('product_id'),
    collectionId: uuid('collection_id'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.campaignId],
      foreignColumns: [promotionalCampaigns.tenantId, promotionalCampaigns.id],
      name: 'ct_campaign_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'ct_product_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.collectionId],
      foreignColumns: [collections.tenantId, collections.id],
      name: 'ct_collection_fk',
    }).onDelete('cascade'),
    check(
      'ct_one_target_check',
      sql`(${t.productId} is not null) <> (${t.collectionId} is not null)`,
    ),
    index('ct_tenant_idx').on(t.tenantId),
  ],
).enableRLS();

export const DISCOUNT_KINDS = ['percentage', 'fixed'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];
export const DISCOUNT_SCOPES = ['all', 'products', 'collections'] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];

/**
 * A tenant's discount code (migration 0053). `value` is basis points for a percentage and paise for a fixed amount.
 * `redemptionCount` is changed only by the order transaction, never by the dashboard (column grants).
 */
export const discountCodes = pgTable(
  'discount_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id'),
    code: text('code').notNull(),
    description: text('description'),
    kind: text('kind', { enum: DISCOUNT_KINDS }).notNull(),
    value: minor('value').notNull(),
    minSubtotalMinor: minor('min_subtotal_minor').notNull().default(0),
    maxDiscountMinor: minor('max_discount_minor'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    usageLimit: integer('usage_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    appliesTo: text('applies_to', { enum: DISCOUNT_SCOPES })
      .notNull()
      .default('all'),
    isActive: boolean('is_active').notNull().default(true),
    redemptionCount: integer('redemption_count').notNull().default(0),
    createdAt: stamp('created_at'),
    createdBy: actor('created_by'),
    updatedAt: stamp('updated_at'),
    updatedBy: actor('updated_by'),
  },
  (t) => [
    unique('dc_tenant_id_id_key').on(t.tenantId, t.id),
    unique('dc_tenant_code_key').on(t.tenantId, t.code),
    foreignKey({
      columns: [t.tenantId, t.campaignId],
      foreignColumns: [promotionalCampaigns.tenantId, promotionalCampaigns.id],
      name: 'dc_campaign_fk',
    }),
    index('dc_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    check('dc_code_check', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'`),
    check('dc_kind_check', sql`${t.kind} in ('percentage', 'fixed')`),
    check(
      'dc_value_check',
      sql`(${t.kind} = 'percentage' and ${t.value} between 1 and 10000) or (${t.kind} = 'fixed' and ${t.value} >= 1)`,
    ),
    check(
      'dc_window_check',
      sql`${t.startsAt} is null or ${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt}`,
    ),
  ],
).enableRLS();

/** The products or collections a code is limited to (when `appliesTo` is not `all`). */
export const discountCodeTargets = pgTable(
  'discount_code_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    discountId: uuid('discount_id').notNull(),
    productId: uuid('product_id'),
    collectionId: uuid('collection_id'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.discountId],
      foreignColumns: [discountCodes.tenantId, discountCodes.id],
      name: 'dct_discount_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'dct_product_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.collectionId],
      foreignColumns: [collections.tenantId, collections.id],
      name: 'dct_collection_fk',
    }).onDelete('cascade'),
    check(
      'dct_one_target_check',
      sql`(${t.productId} is not null) <> (${t.collectionId} is not null)`,
    ),
    index('dct_tenant_idx').on(t.tenantId),
  ],
).enableRLS();

/** One row per order that used a code; the order is the identity, so a replayed checkout cannot redeem twice. */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    discountId: uuid('discount_id'),
    orderId: uuid('order_id').notNull(),
    code: text('code').notNull(),
    customerKey: text('customer_key').notNull(),
    discountMinor: minor('discount_minor').notNull(),
    createdAt: stamp('created_at'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.discountId],
      foreignColumns: [discountCodes.tenantId, discountCodes.id],
      name: 'dr_discount_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'dr_order_fk',
    }).onDelete('cascade'),
    unique('dr_order_key').on(t.tenantId, t.orderId),
    index('dr_discount_customer_idx').on(t.discountId, t.customerKey),
    index('dr_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  ],
).enableRLS();

/** Abandoned-cart settings of one tenant (migration 0053). Defaults apply until a row is saved. */
export const tenantMarketingSettings = pgTable(
  'tenant_marketing_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    abandonmentThresholdMinutes: integer('abandonment_threshold_minutes')
      .notNull()
      .default(60),
    recoveryLinkDays: integer('recovery_link_days').notNull().default(14),
    updatedAt: stamp('updated_at'),
    updatedBy: actor('updated_by'),
  },
  (t) => [
    check(
      'tms_threshold_check',
      sql`${t.abandonmentThresholdMinutes} between 15 and 10080`,
    ),
    check('tms_link_days_check', sql`${t.recoveryLinkDays} between 1 and 90`),
  ],
).enableRLS();

export const ABANDONED_CART_STATUSES = [
  'active',
  'abandoned',
  'recovered',
  'expired',
] as const;
export type AbandonedCartStatus = (typeof ABANDONED_CART_STATUSES)[number];

export interface AbandonedCartItem {
  productId: string;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

/**
 * A server-side checkpoint of a cart whose shopper gave an email at checkout (migration 0053). Only hashes of the browser's
 * cart id and of the recovery token are stored. `marketingConsent` gates any contact; nothing is ever sent from here.
 */
export const abandonedCarts = pgTable(
  'abandoned_carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    cartKeyHash: text('cart_key_hash').notNull(),
    recoveryTokenHash: text('recovery_token_hash').notNull(),
    customerId: uuid('customer_id'),
    email: text('email'),
    phone: text('phone'),
    customerName: text('customer_name'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    items: jsonb('items').$type<AbandonedCartItem[]>().notNull(),
    itemCount: integer('item_count').notNull(),
    cartValueMinor: minor('cart_value_minor').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ABANDONED_CART_STATUSES })
      .notNull()
      .default('active'),
    lastActivityAt: stamp('last_activity_at'),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
    recoveredOrderId: uuid('recovered_order_id'),
    recoveryClicks: integer('recovery_clicks').notNull().default(0),
    createdAt: stamp('created_at'),
    updatedAt: stamp('updated_at'),
  },
  (t) => [
    unique('ac_tenant_id_id_key').on(t.tenantId, t.id),
    unique('ac_tenant_cart_key').on(t.tenantId, t.cartKeyHash),
    unique('ac_recovery_token_key').on(t.recoveryTokenHash),
    foreignKey({
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'ac_customer_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.recoveredOrderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'ac_order_fk',
    }),
    check(
      'ac_status_check',
      sql`${t.status} in ('active', 'abandoned', 'recovered', 'expired')`,
    ),
    index('ac_tenant_status_activity_idx').on(
      t.tenantId,
      t.status,
      t.lastActivityAt.desc(),
    ),
    index('ac_tenant_abandoned_idx')
      .on(t.tenantId, t.abandonedAt.desc())
      .where(sql`${t.abandonedAt} is not null`),
  ],
).enableRLS();

export const INTEGRATION_VALIDATION_STATUSES = [
  'unverified',
  'valid',
  'invalid',
] as const;
export type IntegrationValidationStatus =
  (typeof INTEGRATION_VALIDATION_STATUSES)[number];

/**
 * A tenant's connection to one marketing / analytics provider (migration 0053), e.g. `ga4` or `meta_pixel`. `config` holds
 * the public identifiers; the optional ciphertext is a future server-side secret that the request role can never read.
 * Enabling needs a successful validation; changing `config` or the secret switches the integration off (trigger).
 */
export const marketingIntegrations = pgTable(
  'marketing_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    providerCode: text('provider_code').notNull(),
    config: jsonb('config')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    secretCiphertext: text('secret_ciphertext'),
    iv: text('iv'),
    authTag: text('auth_tag'),
    keyVersion: smallint('key_version'),
    enabled: boolean('enabled').notNull().default(false),
    validationStatus: text('validation_status', {
      enum: INTEGRATION_VALIDATION_STATUSES,
    })
      .notNull()
      .default('unverified'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    validationError: text('validation_error'),
    createdAt: stamp('created_at'),
    createdBy: actor('created_by'),
    updatedAt: stamp('updated_at'),
    updatedBy: actor('updated_by'),
  },
  (t) => [
    unique('mi_tenant_provider_key').on(t.tenantId, t.providerCode),
    check(
      'mi_provider_check',
      sql`${t.providerCode} ~ '^[a-z][a-z0-9_]{1,30}$'`,
    ),
    check(
      'mi_enabled_needs_valid_check',
      sql`not ${t.enabled} or ${t.validationStatus} = 'valid'`,
    ),
  ],
).enableRLS();

export const INTEGRATION_EVENT_ACTIONS = [
  'configure',
  'update',
  'validate',
  'validate_failed',
  'enable',
  'disable',
  'remove',
] as const;
export type IntegrationEventAction = (typeof INTEGRATION_EVENT_ACTIONS)[number];

/** Append-only history of integration changes. Never holds a secret or an identifier value. */
export const marketingIntegrationEvents = pgTable(
  'marketing_integration_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    providerCode: text('provider_code').notNull(),
    action: text('action', { enum: INTEGRATION_EVENT_ACTIONS }).notNull(),
    actorId: uuid('actor_id'),
    note: text('note'),
    createdAt: stamp('created_at'),
  },
  (t) => [index('mie_tenant_created_idx').on(t.tenantId, t.createdAt.desc())],
).enableRLS();

export type DiscountCode = typeof discountCodes.$inferSelect;
export type PromotionalCampaign = typeof promotionalCampaigns.$inferSelect;
export type AbandonedCart = typeof abandonedCarts.$inferSelect;
export type MarketingIntegration = typeof marketingIntegrations.$inferSelect;
