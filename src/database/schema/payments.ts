import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users.js';
import { tenants } from './tenants.js';

/**
 * A tenant's Razorpay credentials (migration 0034). The Key Secret exists ONLY as AES-256-GCM ciphertext. The request role may
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
  ],
).enableRLS();
