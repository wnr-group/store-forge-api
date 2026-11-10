import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ORDER_STATUSES } from './enums.js';
import { products, productVariants } from './catalog.js';
import { tenants } from './tenants.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });
const minor = (name: string) => bigint(name, { mode: 'number' });

/** A merchant's customer record. Tenant-scoped; email is unique per tenant (case-insensitive). */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('customers_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('customers_tenant_id_email_key').on(
      t.tenantId,
      sql`lower(${t.email})`,
    ),
    check(
      'customers_email_check',
      sql`char_length(${t.email}) between 3 and 254 and position('@' in ${t.email}) > 1`,
    ),
    check(
      'customers_full_name_check',
      sql`char_length(btrim(${t.fullName})) between 1 and 120`,
    ),
    check(
      'customers_phone_check',
      sql`${t.phone} is null or char_length(${t.phone}) between 4 and 32`,
    ),
    check(
      'customers_notes_check',
      sql`${t.notes} is null or char_length(${t.notes}) <= 2000`,
    ),
    index('customers_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  ],
).enableRLS();

/**
 * Orders are READ-ONLY for merchants in this release: there is no checkout yet,
 * so the dashboard has no way to create them and `authenticated` has no INSERT
 * privilege. Analytics and customer totals read this table and show honest
 * empty states until a checkout service starts writing it.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    orderNumber: integer('order_number').notNull(),
    status: text('status', { enum: ORDER_STATUSES })
      .notNull()
      .default('pending'),
    currency: text('currency').notNull(),
    subtotalMinor: minor('subtotal_minor').notNull(),
    totalMinor: minor('total_minor').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('orders_tenant_id_id_key').on(t.tenantId, t.id),
    unique('orders_tenant_id_order_number_key').on(t.tenantId, t.orderNumber),
    check(
      'orders_status_check',
      sql`${t.status} in ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded')`,
    ),
    check('orders_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'orders_amounts_check',
      sql`${t.subtotalMinor} >= 0 and ${t.totalMinor} >= 0`,
    ),
    index('orders_tenant_placed_idx').on(t.tenantId, t.placedAt.desc()),
    index('orders_customer_id_idx').on(t.customerId),
  ],
).enableRLS();

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),
    variantId: uuid('variant_id').references(() => productVariants.id, {
      onDelete: 'set null',
    }),
    /** Snapshots: the order keeps its name/SKU/price even if the product is edited or deleted. */
    name: text('name').notNull(),
    sku: text('sku'),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: minor('unit_price_minor').notNull(),
    totalMinor: minor('total_minor').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_items_order_fk',
    }).onDelete('cascade'),
    check('order_items_quantity_check', sql`${t.quantity} > 0`),
    check(
      'order_items_amounts_check',
      sql`${t.unitPriceMinor} >= 0 and ${t.totalMinor} >= 0`,
    ),
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_product_id_idx').on(t.productId),
  ],
).enableRLS();

export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
