import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from 'drizzle-orm/supabase';
import { SLUG_PATTERN, TENANT_STATUSES } from './enums.js';

/** A merchant organisation. Created only by a Platform Admin through platform_provision_tenant(). */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status', { enum: TENANT_STATUSES })
      .notNull()
      .default('active'),
    contactPhone: text('contact_phone'),
    address: text('address'),
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
    unique('tenants_slug_key').on(t.slug),
    check(
      'tenants_name_check',
      sql`char_length(btrim(${t.name})) between 2 and 80`,
    ),
    check(
      'tenants_slug_check',
      sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`,
    ),
    check('tenants_status_check', sql`${t.status} in ('active', 'suspended')`),
    check(
      'tenants_contact_phone_check',
      sql`${t.contactPhone} is null or char_length(${t.contactPhone}) between 4 and 32`,
    ),
    check(
      'tenants_address_check',
      sql`${t.address} is null or char_length(${t.address}) <= 300`,
    ),
    index('tenants_created_by_idx').on(t.createdBy),
    index('tenants_created_idx').on(t.createdAt.desc(), t.id),
  ],
).enableRLS();

export type Tenant = typeof tenants.$inferSelect;
