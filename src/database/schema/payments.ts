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
