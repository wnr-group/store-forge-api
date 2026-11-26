import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users.js';
import { billingInvoices } from './billing.js';
import { plans } from './subscriptions.js';
import { tenants } from './tenants.js';

export const SIGNUP_ORDER_STATUSES = [
  'created',
  'paid',
  'provisioned',
  'canceled',
] as const;
export type SignupOrderStatus = (typeof SIGNUP_ORDER_STATUSES)[number];

/**
 * Self-service sign-up purchases (migration 0070): a customer buys a plan BEFORE their organization exists, so this row is what ties the
 * payment to the person. A person reads only their own rows (row level security); every change goes through the SECURITY DEFINER
 * `signup_*` functions, which hold the rules (price, settlement, idempotency).
 */
export const signupOrders = pgTable(
  'signup_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    billingInterval: text('billing_interval').notNull(),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    taxRateBps: integer('tax_rate_bps').notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    status: text('status', { enum: SIGNUP_ORDER_STATUSES })
      .notNull()
      .default('created'),
    razorpayOrderId: text('razorpay_order_id'),
    razorpayPaymentId: text('razorpay_payment_id'),
    paymentMethod: text('payment_method'),
    lastFailureCode: text('last_failure_code'),
    lastFailureDescription: text('last_failure_description'),
    /** Money arrived for an order that was already settled or replaced: it has to be refunded. */
    refundRequired: boolean('refund_required').notNull().default(false),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    invoiceId: uuid('invoice_id').references(() => billingInvoices.id, {
      onDelete: 'set null',
    }),
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('signup_orders_razorpay_order_key')
      .on(t.razorpayOrderId)
      .where(sql`${t.razorpayOrderId} is not null`),
    uniqueIndex('signup_orders_razorpay_payment_key')
      .on(t.razorpayPaymentId)
      .where(sql`${t.razorpayPaymentId} is not null`),
    uniqueIndex('signup_orders_open_user_key')
      .on(t.userId)
      .where(sql`${t.status} in ('created', 'paid')`),
    index('signup_orders_user_idx').on(t.userId, t.createdAt.desc()),
    check(
      'signup_orders_status_check',
      sql`${t.status} in ('created', 'paid', 'provisioned', 'canceled')`,
    ),
    check(
      'signup_orders_interval_check',
      sql`${t.billingInterval} in ('monthly', 'yearly')`,
    ),
    check('signup_orders_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'signup_orders_amounts_check',
      sql`${t.subtotalMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.totalMinor} = ${t.subtotalMinor} + ${t.taxMinor} and ${t.taxRateBps} between 0 and 10000`,
    ),
    check(
      'signup_orders_paid_check',
      sql`(${t.status} in ('paid', 'provisioned')) = (${t.paidAt} is not null) or ${t.status} = 'canceled'`,
    ),
  ],
).enableRLS();
