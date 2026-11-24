import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Subscription billing (migration 0064). A Platform Admin reads all of it; a tenant Owner reads only its own invoices, payments and
 * refunds (row level security). Nothing here is written by the API directly except `billing_settings`: invoices, payments and
 * refunds change only through the SECURITY DEFINER billing functions, which hold the rules (settlement, renewals, refunds).
 */
export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const BILLING_PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
] as const;
export type BillingPaymentStatus = (typeof BILLING_PAYMENT_STATUSES)[number];
export const BILLING_REFUND_STATUSES = [
  'pending',
  'processed',
  'failed',
] as const;

export const billingSettings = pgTable(
  'billing_settings',
  {
    id: boolean('id').primaryKey().default(true),
    legalName: text('legal_name').notNull().default('StoreForge'),
    address: text('address'),
    gstin: text('gstin'),
    taxLabel: text('tax_label').notNull().default('GST'),
    /** Tax rate in basis points (1800 = 18%), added on top of the plan price. */
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    dueDays: integer('due_days').notNull().default(7),
    graceDays: integer('grace_days').notNull().default(7),
    renewalNoticeDays: integer('renewal_notice_days').notNull().default(7),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [check('billing_settings_singleton_check', sql`${t.id}`)],
).enableRLS();

export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: text('number').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    tenantName: text('tenant_name').notNull(),
    subscriptionId: uuid('subscription_id'),
    planCode: text('plan_code').notNull(),
    planName: text('plan_name').notNull(),
    billingInterval: text('billing_interval').notNull(),
    description: text('description').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    taxRateBps: integer('tax_rate_bps').notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    seller: jsonb('seller')
      .$type<{
        legalName: string;
        address: string | null;
        gstin: string | null;
        taxLabel: string;
      }>()
      .notNull(),
    status: text('status', { enum: INVOICE_STATUSES })
      .notNull()
      .default('open'),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by'),
  },
  (t) => [
    uniqueIndex('billing_invoices_number_key').on(t.number),
    uniqueIndex('billing_invoices_period_key')
      .on(t.tenantId, t.periodStart)
      .where(sql`${t.status} <> 'void'`),
    index('billing_invoices_tenant_idx').on(t.tenantId, t.issuedAt.desc()),
    index('billing_invoices_status_due_idx').on(t.status, t.dueAt),
  ],
).enableRLS();

export const billingPayments = pgTable(
  'billing_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => billingInvoices.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id').notNull(),
    provider: text('provider', { enum: ['razorpay', 'manual'] }).notNull(),
    status: text('status', { enum: BILLING_PAYMENT_STATUSES })
      .notNull()
      .default('pending'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    razorpayOrderId: text('razorpay_order_id'),
    razorpayPaymentId: text('razorpay_payment_id'),
    method: text('method'),
    reference: text('reference'),
    note: text('note'),
    failureCode: text('failure_code'),
    failureDescription: text('failure_description'),
    /** Money arrived for an invoice that was already paid or void: it has to be refunded. */
    refundRequired: boolean('refund_required').notNull().default(false),
    refundedMinor: bigint('refunded_minor', { mode: 'number' })
      .notNull()
      .default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    recordedBy: uuid('recorded_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_payments_order_key')
      .on(t.razorpayOrderId)
      .where(sql`${t.razorpayOrderId} is not null`),
    uniqueIndex('billing_payments_payment_key')
      .on(t.razorpayPaymentId)
      .where(sql`${t.razorpayPaymentId} is not null`),
    index('billing_payments_tenant_idx').on(t.tenantId, t.createdAt.desc()),
    index('billing_payments_invoice_idx').on(t.invoiceId),
    index('billing_payments_status_idx').on(t.status, t.createdAt.desc()),
  ],
).enableRLS();

export const billingRefunds = pgTable(
  'billing_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => billingPayments.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: BILLING_REFUND_STATUSES })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    razorpayRefundId: text('razorpay_refund_id'),
    failureReason: text('failure_reason'),
    requestedBy: uuid('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('billing_refunds_key').on(t.paymentId, t.idempotencyKey),
    uniqueIndex('billing_refunds_razorpay_key')
      .on(t.razorpayRefundId)
      .where(sql`${t.razorpayRefundId} is not null`),
    index('billing_refunds_tenant_idx').on(t.tenantId, t.createdAt.desc()),
  ],
).enableRLS();

export const billingWebhookEvents = pgTable(
  'billing_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    razorpayOrderId: text('razorpay_order_id'),
    razorpayPaymentId: text('razorpay_payment_id'),
    razorpayRefundId: text('razorpay_refund_id'),
    status: text('status', {
      enum: ['received', 'processed', 'ignored', 'failed'],
    })
      .notNull()
      .default('received'),
    note: text('note'),
    attempts: integer('attempts').notNull().default(1),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('billing_webhook_events_event_key').on(t.eventId),
    index('billing_webhook_events_received_idx').on(t.receivedAt.desc()),
  ],
).enableRLS();

export type BillingSettings = typeof billingSettings.$inferSelect;
export type BillingInvoice = typeof billingInvoices.$inferSelect;
export type BillingPayment = typeof billingPayments.$inferSelect;
export type BillingRefund = typeof billingRefunds.$inferSelect;
