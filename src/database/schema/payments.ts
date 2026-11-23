import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orders } from './customers.js';
import { authUsers } from './auth-users.js';
import { tenants } from './tenants.js';

/**
 * A tenant's Razorpay credentials (migration 0042). The Key Secret exists ONLY as AES-256-GCM ciphertext. The request role may
 * SELECT just tenant_id, key_id, updated_at and updated_by (column privileges), so the secret columns are never read by the
 * application; they are written through one upsert and never returned. Access goes through the API only (RLS, Owner only).
 */
export const tenantRazorpayConfig = pgTable(
  'tenant_razorpay_config',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    keyVersion: smallint('key_version').notNull(),
    // Webhook secret (migration 0044): all five NULL, or all set. Ciphertext only; the request role reads just the timestamp.
    webhookSecretCiphertext: text('webhook_secret_ciphertext'),
    webhookSecretIv: text('webhook_secret_iv'),
    webhookSecretAuthTag: text('webhook_secret_auth_tag'),
    webhookSecretKeyVersion: smallint('webhook_secret_key_version'),
    webhookSecretUpdatedAt: timestamp('webhook_secret_updated_at', {
      withTimezone: true,
    }),
    /** Migration 0047: whether the tenant takes Razorpay payments, and the outcome of the last credential check. */
    enabled: boolean('enabled').notNull().default(false),
    verificationStatus: text('verification_status', {
      enum: ['unverified', 'verified', 'failed'],
    })
      .notNull()
      .default('unverified'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationError: text('verification_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check(
      'trc_key_id_check',
      sql`${t.keyId} ~ '^rzp_(test|live)_[A-Za-z0-9]{8,}$'`,
    ),
    check('trc_key_version_check', sql`${t.keyVersion} >= 1`),
    check('trc_iv_check', sql`${t.iv} ~ '^[A-Za-z0-9+/]{16}$'`),
    check('trc_auth_tag_check', sql`${t.authTag} ~ '^[A-Za-z0-9+/]{22}==$'`),
    check(
      'trc_ciphertext_check',
      sql`${t.secretCiphertext} ~ '^[A-Za-z0-9+/]+={0,2}$' and char_length(${t.secretCiphertext}) <= 2048`,
    ),
    check(
      'trc_webhook_all_or_none_check',
      sql`(${t.webhookSecretCiphertext} is null and ${t.webhookSecretIv} is null and ${t.webhookSecretAuthTag} is null and ${t.webhookSecretKeyVersion} is null and ${t.webhookSecretUpdatedAt} is null) or (${t.webhookSecretCiphertext} is not null and ${t.webhookSecretIv} is not null and ${t.webhookSecretAuthTag} is not null and ${t.webhookSecretKeyVersion} is not null and ${t.webhookSecretUpdatedAt} is not null)`,
    ),
    check(
      'trc_webhook_key_version_check',
      sql`${t.webhookSecretKeyVersion} is null or ${t.webhookSecretKeyVersion} >= 1`,
    ),
    check(
      'trc_webhook_iv_check',
      sql`${t.webhookSecretIv} is null or ${t.webhookSecretIv} ~ '^[A-Za-z0-9+/]{16}$'`,
    ),
    check(
      'trc_webhook_auth_tag_check',
      sql`${t.webhookSecretAuthTag} is null or ${t.webhookSecretAuthTag} ~ '^[A-Za-z0-9+/]{22}==$'`,
    ),
    check(
      'trc_webhook_ciphertext_check',
      sql`${t.webhookSecretCiphertext} is null or (${t.webhookSecretCiphertext} ~ '^[A-Za-z0-9+/]+={0,2}$' and char_length(${t.webhookSecretCiphertext}) <= 2048)`,
    ),
  ],
).enableRLS();

/** A tenant's Cash on Delivery settings (migration 0047). Owner only. */
export const tenantCodConfig = pgTable(
  'tenant_cod_config',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    minOrderMinor: bigint('min_order_minor', { mode: 'number' })
      .notNull()
      .default(0),
    maxOrderMinor: bigint('max_order_minor', { mode: 'number' }),
    feeMinor: bigint('fee_minor', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    check(
      'tcc_amounts_check',
      sql`${t.minOrderMinor} >= 0 and ${t.feeMinor} >= 0 and (${t.maxOrderMinor} is null or ${t.maxOrderMinor} >= ${t.minOrderMinor}) and ${t.minOrderMinor} <= 100000000000 and ${t.feeMinor} <= 100000000000`,
    ),
  ],
).enableRLS();

export const PAYMENT_TRANSACTION_STATUSES = [
  'created',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'pending_collection',
  'collected',
] as const;
export type PaymentTransactionStatus =
  (typeof PAYMENT_TRANSACTION_STATUSES)[number];

/** One row per order and provider (migration 0047). Online rows carry the Razorpay ids; COD rows track collection. */
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    provider: text('provider', { enum: ['razorpay', 'cod'] }).notNull(),
    status: text('status', { enum: PAYMENT_TRANSACTION_STATUSES }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    razorpayOrderId: text('razorpay_order_id'),
    razorpayPaymentId: text('razorpay_payment_id'),
    method: text('method'),
    failureCode: text('failure_code'),
    failureDescription: text('failure_description'),
    attempts: integer('attempts').notNull().default(0),
    refundRequired: boolean('refund_required').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    collectedBy: uuid('collected_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'payment_transactions_order_fk',
    }).onDelete('cascade'),
    unique('payment_transactions_tenant_id_id_key').on(t.tenantId, t.id),
    unique('payment_transactions_order_provider_key').on(t.orderId, t.provider),
    uniqueIndex('payment_transactions_razorpay_order_key')
      .on(t.tenantId, t.razorpayOrderId)
      .where(sql`${t.razorpayOrderId} is not null`),
    uniqueIndex('payment_transactions_razorpay_payment_key')
      .on(t.tenantId, t.razorpayPaymentId)
      .where(sql`${t.razorpayPaymentId} is not null`),
    index('payment_transactions_tenant_created_idx').on(
      t.tenantId,
      t.createdAt.desc(),
    ),
  ],
).enableRLS();

export type TenantCodConfig = typeof tenantCodConfig.$inferSelect;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;

export const REFUND_STATUSES = [
  'pending',
  'processing',
  'processed',
  'failed',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** A refund request (migration 0048). Inserted as 'pending' before Razorpay is called; its id is the Razorpay `receipt`. */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    paymentTransactionId: uuid('payment_transaction_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: REFUND_STATUSES })
      .notNull()
      .default('pending'),
    reason: text('reason'),
    source: text('source', { enum: ['storeforge', 'razorpay_dashboard'] })
      .notNull()
      .default('storeforge'),
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
    foreignKey({
      columns: [t.tenantId, t.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'refunds_order_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.paymentTransactionId],
      foreignColumns: [paymentTransactions.tenantId, paymentTransactions.id],
      name: 'refunds_transaction_fk',
    }).onDelete('cascade'),
    unique('refunds_tenant_id_id_key').on(t.tenantId, t.id),
    unique('refunds_tenant_idempotency_key').on(t.tenantId, t.idempotencyKey),
    uniqueIndex('refunds_razorpay_refund_key')
      .on(t.tenantId, t.razorpayRefundId)
      .where(sql`${t.razorpayRefundId} is not null`),
    index('refunds_transaction_idx').on(t.paymentTransactionId),
    index('refunds_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  ],
).enableRLS();

/** Every authenticated Razorpay webhook, once per (tenant, event id) (migration 0048). */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
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
    unique('payment_webhook_events_tenant_event_key').on(t.tenantId, t.eventId),
    index('payment_webhook_events_order_idx').on(t.tenantId, t.razorpayOrderId),
    index('payment_webhook_events_received_idx').on(
      t.tenantId,
      t.receivedAt.desc(),
    ),
  ],
).enableRLS();

export type Refund = typeof refunds.$inferSelect;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
