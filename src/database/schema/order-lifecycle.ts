import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { products, productVariants } from './catalog.js';
import { orders } from './customers.js';
import { tenants } from './tenants.js';

/** Tables added by migration 0045. Policies, grants and the checkout role live in the SQL migration. */
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

/** Shipping and billing address snapshots, one per kind per order. */
export const orderAddresses = pgTable(
  'order_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind', { enum: ['shipping', 'billing'] }).notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    stateCode: text('state_code'),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull().default('IN'),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_addresses_order_fk',
    }).onDelete('cascade'),
    unique('order_addresses_order_kind_key').on(t.orderId, t.kind),
    check(
      'order_addresses_kind_check',
      sql`${t.kind} in ('shipping', 'billing')`,
    ),
    check('order_addresses_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    index('order_addresses_postal_idx').on(t.tenantId, t.postalCode),
  ],
).enableRLS();

/** Append-only audit trail of every status change. */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorType: text('actor_type', {
      enum: ['customer', 'owner', 'member', 'system', 'payment', 'carrier'],
    }).notNull(),
    actorId: uuid('actor_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_status_history_order_fk',
    }).onDelete('cascade'),
    index('order_status_history_order_idx').on(t.orderId, t.createdAt),
  ],
).enableRLS();

/** Stock held for an unpaid order. Available stock = on hand minus active reservations. */
export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    quantity: integer('quantity').notNull(),
    status: text('status', {
      enum: ['active', 'committed', 'released', 'expired'],
    })
      .notNull()
      .default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'inventory_reservations_order_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'inventory_reservations_product_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.id],
      name: 'inventory_reservations_variant_fk',
    }).onDelete('cascade'),
    check('inventory_reservations_quantity_check', sql`${t.quantity} > 0`),
    index('inventory_reservations_order_idx').on(t.orderId),
  ],
).enableRLS();

/** Gap-free order numbers per tenant; bumped inside the order transaction. */
export const tenantOrderCounters = pgTable('tenant_order_counters', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  lastNumber: integer('last_number').notNull().default(0),
}).enableRLS();

export type OrderAddress = typeof orderAddresses.$inferSelect;
export type OrderStatusHistoryRow = typeof orderStatusHistory.$inferSelect;
export type InventoryReservation = typeof inventoryReservations.$inferSelect;
