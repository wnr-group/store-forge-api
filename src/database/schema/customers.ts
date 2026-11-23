import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import {
  ORDER_FULFILLMENT_STATUSES,
  ORDER_PAYMENT_METHODS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
} from './enums.js';
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
 * Orders (migrations 0005, 0045). They are CREATED only by the checkout service, through the tenant-pinned
 * `storeforge_checkout` role; dashboard users can change the lifecycle columns, never insert or delete.
 * `status` is the lifecycle (see modules/orders/order-state.ts), `payment_status` the money state, and the amounts keep the
 * exact breakdown applied at placement, so later setting changes never rewrite history.
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
      .default('pending_payment'),
    paymentMethod: text('payment_method', { enum: ORDER_PAYMENT_METHODS }),
    paymentStatus: text('payment_status', { enum: ORDER_PAYMENT_STATUSES })
      .notNull()
      .default('unpaid'),
    fulfillmentStatus: text('fulfillment_status', {
      enum: ORDER_FULFILLMENT_STATUSES,
    })
      .notNull()
      .default('unfulfilled'),
    currency: text('currency').notNull(),
    subtotalMinor: minor('subtotal_minor').notNull(),
    discountMinor: minor('discount_minor').notNull().default(0),
    shippingMinor: minor('shipping_minor').notNull().default(0),
    codFeeMinor: minor('cod_fee_minor').notNull().default(0),
    taxMinor: minor('tax_minor').notNull().default(0),
    taxInclusive: boolean('tax_inclusive').notNull().default(false),
    totalMinor: minor('total_minor').notNull(),
    customerName: text('customer_name'),
    customerEmail: text('customer_email'),
    customerPhone: text('customer_phone'),
    idempotencyKey: text('idempotency_key'),
    /** SHA-256 of the guest access token returned once at placement (migration 0046). Never returned by any DTO. */
    accessTokenHash: text('access_token_hash'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
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
      sql`${t.status} in ('pending_payment', 'confirmed', 'processing', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'failed', 'returned')`,
    ),
    check('orders_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'orders_amounts_check',
      sql`${t.subtotalMinor} >= 0 and ${t.totalMinor} >= 0`,
    ),
    index('orders_tenant_placed_idx').on(t.tenantId, t.placedAt.desc()),
    index('orders_customer_id_idx').on(t.customerId),
    uniqueIndex('orders_tenant_idempotency_key')
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('orders_tenant_status_idx').on(
      t.tenantId,
      t.status,
      t.placedAt.desc(),
    ),
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
    taxMinor: minor('tax_minor').notNull().default(0),
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    hsnCode: text('hsn_code'),
    weightGrams: integer('weight_grams').notNull().default(0),
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
