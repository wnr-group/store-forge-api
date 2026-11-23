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
import { tenants } from './tenants.js';

/**
 * A tenant's own account with one shipping carrier (migration 0049). Secret credentials exist only as AES-256-GCM
 * ciphertext; the request role cannot read those columns. `settings` holds the non-secret values the dashboard shows,
 * `secretKeys` names which secrets are saved. Enabling needs a successful check; a default must be enabled.
 */
export const tenantCarrierConnections = pgTable(
  'tenant_carrier_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    providerCode: text('provider_code').notNull(),
    settings: jsonb('settings')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    secretKeys: text('secret_keys').array().notNull().default([]),
    secretsCiphertext: text('secrets_ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    keyVersion: smallint('key_version').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    verificationStatus: text('verification_status', {
      enum: ['unverified', 'verified', 'failed'],
    })
      .notNull()
      .default('unverified'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationError: text('verification_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid('created_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    unique('tcc_tenant_provider_key').on(t.tenantId, t.providerCode),
    unique('tcc_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('tcc_one_default_per_tenant')
      .on(t.tenantId)
      .where(sql`${t.isDefault}`),
    check(
      'tcc_provider_check',
      sql`${t.providerCode} ~ '^[a-z][a-z0-9_]{1,30}$'`,
    ),
    check(
      'tcc_enabled_needs_verified_check',
      sql`not ${t.enabled} or ${t.verificationStatus} = 'verified'`,
    ),
    check(
      'tcc_default_needs_enabled_check',
      sql`not ${t.isDefault} or ${t.enabled}`,
    ),
  ],
).enableRLS();

export const CARRIER_EVENT_ACTIONS = [
  'connect',
  'update',
  'verify',
  'verify_failed',
  'enable',
  'disable',
  'set_default',
  'unset_default',
  'disconnect',
] as const;
export type CarrierEventAction = (typeof CARRIER_EVENT_ACTIONS)[number];

/** Append-only history of changes to carrier connections (migration 0049). Never holds a credential value. */
export const carrierConnectionEvents = pgTable(
  'carrier_connection_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    providerCode: text('provider_code').notNull(),
    action: text('action', { enum: CARRIER_EVENT_ACTIONS }).notNull(),
    actorId: uuid('actor_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('cce_tenant_created_idx').on(t.tenantId, t.createdAt.desc())],
).enableRLS();

export const CARRIER_SELECTION_MODES = ['manual', 'automatic'] as const;
export const CARRIER_STRATEGIES = [
  'lowest_cost',
  'fastest',
  'preferred',
] as const;

/** How a carrier is chosen for an order (migration 0049). `preferred` means the connection marked as default. */
export const tenantShippingPreferences = pgTable(
  'tenant_shipping_preferences',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    selectionMode: text('selection_mode', { enum: CARRIER_SELECTION_MODES })
      .notNull()
      .default('manual'),
    strategy: text('strategy', { enum: CARRIER_STRATEGIES })
      .notNull()
      .default('lowest_cost'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
  },
).enableRLS();

export type TenantCarrierConnection =
  typeof tenantCarrierConnections.$inferSelect;
export type TenantShippingPreferences =
  typeof tenantShippingPreferences.$inferSelect;

// --- Zones, methods and rates (migration 0050) ------------------------------------------------------------------------------

export const ZONE_AREA_KINDS = [
  'country',
  'state',
  'city',
  'postal_code',
  'postal_range',
] as const;
export type ZoneAreaKind = (typeof ZONE_AREA_KINDS)[number];

export const SHIPPING_PRICING_TYPES = [
  'flat',
  'free',
  'weight',
  'order_value',
  'carrier',
] as const;
export type ShippingPricingType = (typeof SHIPPING_PRICING_TYPES)[number];

export const SHIPPING_METHOD_KINDS = ['standard', 'express'] as const;

/** A group of destinations that share shipping methods. A destination belongs to the zone with its most specific area. */
export const shippingZones = pgTable(
  'shipping_zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    codAllowed: boolean('cod_allowed').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('shipping_zones_tenant_id_id_key').on(t.tenantId, t.id),
    unique('shipping_zones_tenant_name_key').on(t.tenantId, t.name),
  ],
).enableRLS();

export const shippingZoneAreas = pgTable(
  'shipping_zone_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    zoneId: uuid('zone_id').notNull(),
    kind: text('kind', { enum: ZONE_AREA_KINDS }).notNull(),
    stateCode: text('state_code'),
    city: text('city'),
    postalCode: text('postal_code'),
    postalFrom: text('postal_from'),
    postalTo: text('postal_to'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.zoneId],
      foreignColumns: [shippingZones.tenantId, shippingZones.id],
      name: 'shipping_zone_areas_zone_fk',
    }).onDelete('cascade'),
    index('shipping_zone_areas_zone_idx').on(t.zoneId),
  ],
).enableRLS();

export const shippingMethods = pgTable(
  'shipping_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    zoneId: uuid('zone_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: SHIPPING_METHOD_KINDS })
      .notNull()
      .default('standard'),
    pricingType: text('pricing_type', {
      enum: SHIPPING_PRICING_TYPES,
    }).notNull(),
    flatRateMinor: bigint('flat_rate_minor', { mode: 'number' })
      .notNull()
      .default(0),
    freeOverMinor: bigint('free_over_minor', { mode: 'number' }),
    handlingMinor: bigint('handling_minor', { mode: 'number' })
      .notNull()
      .default(0),
    minOrderMinor: bigint('min_order_minor', { mode: 'number' })
      .notNull()
      .default(0),
    maxOrderMinor: bigint('max_order_minor', { mode: 'number' }),
    minWeightGrams: integer('min_weight_grams').notNull().default(0),
    maxWeightGrams: integer('max_weight_grams'),
    estDaysMin: integer('est_days_min'),
    estDaysMax: integer('est_days_max'),
    codAllowed: boolean('cod_allowed').notNull().default(true),
    carrierCode: text('carrier_code'),
    sortOrder: integer('sort_order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.zoneId],
      foreignColumns: [shippingZones.tenantId, shippingZones.id],
      name: 'shipping_methods_zone_fk',
    }).onDelete('cascade'),
    unique('shipping_methods_tenant_id_id_key').on(t.tenantId, t.id),
    unique('shipping_methods_zone_name_key').on(t.zoneId, t.name),
    index('shipping_methods_zone_idx').on(t.tenantId, t.zoneId, t.sortOrder),
  ],
).enableRLS();

/** One rate band of a weight- or order-value-priced method: from (inclusive) up to (exclusive; null = no upper limit). */
export const shippingRateTiers = pgTable(
  'shipping_rate_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    methodId: uuid('method_id').notNull(),
    fromValue: bigint('from_value', { mode: 'number' }).notNull(),
    toValue: bigint('to_value', { mode: 'number' }),
    rateMinor: bigint('rate_minor', { mode: 'number' }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.methodId],
      foreignColumns: [shippingMethods.tenantId, shippingMethods.id],
      name: 'shipping_rate_tiers_method_fk',
    }).onDelete('cascade'),
    unique('shipping_rate_tiers_method_from_key').on(t.methodId, t.fromValue),
  ],
).enableRLS();

/** Where parcels are collected: the pickup address for carrier rate lanes and shipments. */
export const tenantShippingOrigin = pgTable('tenant_shipping_origin', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email'),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  stateCode: text('state_code').notNull(),
  postalCode: text('postal_code').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: uuid('updated_by').references(() => authUsers.id, {
    onDelete: 'set null',
  }),
}).enableRLS();

export const SHIPMENT_STATUSES = [
  'creating',
  'created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'undelivered',
  'returning',
  'delivered',
  'returned',
  'cancelled',
  'failed',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Statuses of a parcel that is still the carrier's business: tracked, and it keeps its carrier connection in use. */
export const OPEN_SHIPMENT_STATUSES = [
  'creating',
  'created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'undelivered',
  'returning',
] as const satisfies readonly ShipmentStatus[];

/**
 * A parcel booked with one of the tenant's carriers for some or all of an order's items (migration 0051). Written only by the
 * API through the tenant-pinned checkout role; saved as `creating` before the carrier is called so a lost answer is recoverable.
 * (The foreign key to `orders` lives in the migration.)
 */
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    providerCode: text('provider_code').notNull(),
    status: text('status', { enum: SHIPMENT_STATUSES })
      .notNull()
      .default('creating'),
    serviceCode: text('service_code'),
    courierName: text('courier_name'),
    awb: text('awb'),
    providerOrderId: text('provider_order_id'),
    providerShipmentId: text('provider_shipment_id'),
    trackingUrl: text('tracking_url'),
    estimatedDelivery: timestamp('estimated_delivery', { withTimezone: true }),
    paymentMode: text('payment_mode', { enum: ['prepaid', 'cod'] }).notNull(),
    codAmountMinor: bigint('cod_amount_minor', { mode: 'number' })
      .notNull()
      .default(0),
    declaredValueMinor: bigint('declared_value_minor', { mode: 'number' })
      .notNull()
      .default(0),
    weightGrams: integer('weight_grams').notNull(),
    lengthCm: integer('length_cm'),
    breadthCm: integer('breadth_cm'),
    heightCm: integer('height_cm'),
    labelUrl: text('label_url'),
    hasLabel: boolean('has_label').notNull().default(false),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('shipments_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('shipments_tenant_awb_key')
      .on(t.tenantId, t.providerCode, t.awb)
      .where(sql`${t.awb} is not null`),
    uniqueIndex('shipments_one_creating_per_order')
      .on(t.tenantId, t.orderId)
      .where(sql`${t.status} = 'creating'`),
    index('shipments_order_idx').on(t.tenantId, t.orderId),
    index('shipments_tenant_status_idx').on(
      t.tenantId,
      t.status,
      t.createdAt.desc(),
    ),
    check(
      'shipments_weight_check',
      sql`${t.weightGrams} between 1 and 1000000`,
    ),
  ],
).enableRLS();

/** Which order items (and how many of each) a shipment carries. */
export const shipmentItems = pgTable(
  'shipment_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id').notNull(),
    orderItemId: uuid('order_item_id').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    unique('shipment_items_shipment_item_key').on(t.shipmentId, t.orderItemId),
    index('shipment_items_order_item_idx').on(t.orderItemId),
    check('shipment_items_quantity_check', sql`${t.quantity} > 0`),
  ],
).enableRLS();

/** The tracking history of a shipment. The same carrier update seen twice is recorded once (`eventKey`). */
export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id').notNull(),
    eventKey: text('event_key').notNull(),
    status: text('status').notNull(),
    description: text('description').notNull(),
    location: text('location'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    source: text('source', {
      enum: ['system', 'carrier_api', 'carrier_webhook', 'owner'],
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('shipment_events_key_key').on(t.shipmentId, t.eventKey),
    index('shipment_events_shipment_idx').on(t.shipmentId, t.createdAt.desc()),
  ],
).enableRLS();

export type Shipment = typeof shipments.$inferSelect;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;

export type ShippingZone = typeof shippingZones.$inferSelect;
export type ShippingMethod = typeof shippingMethods.$inferSelect;
export type ShippingRateTier = typeof shippingRateTiers.$inferSelect;
