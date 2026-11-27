import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { customers } from './customers.js';
import { tenants } from './tenants.js';

/**
 * Storefront customer accounts (migration 0071). Reachable ONLY by the tenant-pinned `storeforge_checkout` role: dashboard
 * roles have no grants on these tables, so a password hash is never visible to an owner, staff member or admin.
 */
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

/** One login per shopper per store; points at the merchant's existing `customers` row. */
export const customerAccounts = pgTable(
  'customer_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('customer_accounts_tenant_id_id_key').on(t.tenantId, t.id),
    unique('customer_accounts_customer_key').on(t.customerId),
    foreignKey({
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'customer_accounts_customer_fk',
    }).onDelete('cascade'),
    uniqueIndex('customer_accounts_tenant_email_key').on(
      t.tenantId,
      sql`lower(${t.email})`,
    ),
  ],
).enableRLS();

/** Opaque server-side sessions: only the SHA-256 of the token is stored. */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    accountId: uuid('account_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    unique('customer_sessions_token_key').on(t.tokenHash),
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [customerAccounts.tenantId, customerAccounts.id],
      name: 'customer_sessions_account_fk',
    }).onDelete('cascade'),
    index('customer_sessions_account_idx').on(t.accountId, t.expiresAt),
  ],
).enableRLS();

/** A shopper's saved delivery addresses. */
export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    accountId: uuid('account_id').notNull(),
    label: text('label'),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    stateCode: text('state_code'),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull().default('IN'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.accountId],
      foreignColumns: [customerAccounts.tenantId, customerAccounts.id],
      name: 'customer_addresses_account_fk',
    }).onDelete('cascade'),
    index('customer_addresses_account_idx').on(t.accountId, t.createdAt),
    uniqueIndex('customer_addresses_default_key')
      .on(t.accountId)
      .where(sql`${t.isDefault}`),
  ],
).enableRLS();
