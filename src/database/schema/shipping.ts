import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
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
