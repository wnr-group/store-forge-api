import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  BILLING_INTERVALS,
  PLAN_STATUSES,
  SUBSCRIPTION_STATUSES,
} from '../../common/constants/plan-catalog.js';
import { authUsers } from './auth-users.js';
import { tenants } from './tenants.js';

/**
 * Subscription plans (migration 0062), managed by Platform Admins. Row level security lets only a Platform Admin read or
 * write these tables; a tenant never sees them directly. Prices are integer minor units (paise).
 *
 * `is_unrestricted` plans switch on every feature and apply no limits, so a feature added to the product later is not
 * silently withheld from the tenants that predate plans (the seeded "Legacy" plan). `is_default` is the plan a new tenant
 * receives when the admin does not choose one; at most one plan is the default.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status', { enum: PLAN_STATUSES }).notNull().default('active'),
    currency: text('currency').notNull().default('INR'),
    monthlyPriceMinor: bigint('monthly_price_minor', { mode: 'number' })
      .notNull()
      .default(0),
    yearlyPriceMinor: bigint('yearly_price_minor', { mode: 'number' })
      .notNull()
      .default(0),
    trialDays: integer('trial_days').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    isUnrestricted: boolean('is_unrestricted').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('plans_code_key').on(t.code),
    uniqueIndex('plans_one_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check(
      'plans_code_check',
      sql`${t.code} ~ '^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$'`,
    ),
    check(
      'plans_name_check',
      sql`char_length(btrim(${t.name})) between 2 and 60`,
    ),
    check(
      'plans_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 500`,
    ),
    check('plans_status_check', sql`${t.status} in ('active', 'inactive')`),
    check('plans_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'plans_prices_check',
      sql`${t.monthlyPriceMinor} between 0 and 100000000000 and ${t.yearlyPriceMinor} between 0 and 100000000000`,
    ),
    check('plans_trial_days_check', sql`${t.trialDays} between 0 and 365`),
    check(
      'plans_default_active_check',
      sql`not ${t.isDefault} or ${t.status} = 'active'`,
    ),
  ],
).enableRLS();

/** Which capabilities a plan includes. A missing row means "not included". Keys come from plan-catalog.ts. */
export const planFeatures = pgTable(
  'plan_features',
  {
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.featureKey] }),
    check(
      'plan_features_key_check',
      sql`${t.featureKey} ~ '^[a-z][a-z0-9_]{1,48}$'`,
    ),
  ],
).enableRLS();

/** A plan's numeric limits. A missing row, or a NULL value, means unlimited. `soft` warns, `hard` blocks (soft <= hard). */
export const planLimits = pgTable(
  'plan_limits',
  {
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    limitKey: text('limit_key').notNull(),
    softLimit: bigint('soft_limit', { mode: 'number' }),
    hardLimit: bigint('hard_limit', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.limitKey] }),
    check(
      'plan_limits_key_check',
      sql`${t.limitKey} ~ '^[a-z][a-z0-9_]{1,48}$'`,
    ),
    check(
      'plan_limits_values_check',
      sql`(${t.softLimit} is null or ${t.softLimit} >= 0) and (${t.hardLimit} is null or ${t.hardLimit} >= 0) and (${t.softLimit} is null or ${t.hardLimit} is null or ${t.softLimit} <= ${t.hardLimit})`,
    ),
  ],
).enableRLS();

/**
 * A tenant's current subscription: exactly one row per tenant (migration 0062). Every tenant gets one the moment it is created
 * (trigger), on the default plan, so no creation path can leave a tenant without a plan. Moving to another plan updates this
 * row; the history of who changed what and when is in the audit log, and payments are in the billing tables.
 */
export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
    billingInterval: text('billing_interval', { enum: BILLING_INTERVALS })
      .notNull()
      .default('monthly'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    /** NULL for a plan that is free or has no renewal date. */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tenant_subscriptions_tenant_key').on(t.tenantId),
    index('tenant_subscriptions_plan_idx').on(t.planId),
    index('tenant_subscriptions_status_idx').on(t.status),
    check(
      'tenant_subscriptions_status_check',
      sql`${t.status} in ('trialing', 'active', 'past_due', 'canceled', 'expired')`,
    ),
    check(
      'tenant_subscriptions_interval_check',
      sql`${t.billingInterval} in ('monthly', 'yearly')`,
    ),
  ],
).enableRLS();

export type Plan = typeof plans.$inferSelect;
export type PlanFeature = typeof planFeatures.$inferSelect;
export type PlanLimit = typeof planLimits.$inferSelect;
export type TenantSubscription = typeof tenantSubscriptions.$inferSelect;

/** One tenant's exception to its plan for a single feature (migration 0063). An override always wins over the plan. */
export const tenantFeatureOverrides = pgTable(
  'tenant_feature_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull(),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureKey] }),
    check(
      'tenant_feature_overrides_key_check',
      sql`${t.featureKey} ~ '^[a-z][a-z0-9_]{1,48}$'`,
    ),
    check(
      'tenant_feature_overrides_note_check',
      sql`${t.note} is null or char_length(${t.note}) <= 200`,
    ),
  ],
).enableRLS();

/** One tenant's own limit for a single resource. Both numbers NULL means unlimited for this tenant. */
export const tenantLimitOverrides = pgTable(
  'tenant_limit_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    limitKey: text('limit_key').notNull(),
    softLimit: bigint('soft_limit', { mode: 'number' }),
    hardLimit: bigint('hard_limit', { mode: 'number' }),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.limitKey] }),
    check(
      'tenant_limit_overrides_key_check',
      sql`${t.limitKey} ~ '^[a-z][a-z0-9_]{1,48}$'`,
    ),
    check(
      'tenant_limit_overrides_values_check',
      sql`(${t.softLimit} is null or ${t.softLimit} >= 0) and (${t.hardLimit} is null or ${t.hardLimit} >= 0) and (${t.softLimit} is null or ${t.hardLimit} is null or ${t.softLimit} <= ${t.hardLimit})`,
    ),
    check(
      'tenant_limit_overrides_note_check',
      sql`${t.note} is null or char_length(${t.note}) <= 200`,
    ),
  ],
).enableRLS();

export type TenantFeatureOverride = typeof tenantFeatureOverrides.$inferSelect;
export type TenantLimitOverride = typeof tenantLimitOverrides.$inferSelect;
