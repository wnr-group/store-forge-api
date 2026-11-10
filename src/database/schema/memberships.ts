import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from 'drizzle-orm/supabase';
import {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  type MemberPermissions,
} from './enums.js';
import { tenants } from './tenants.js';

/** User <-> tenant link carrying the role. The 'owner' row is created only by platform_provision_tenant(). */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull(),
    status: text('status', { enum: MEMBERSHIP_STATUSES })
      .notNull()
      .default('active'),
    /** Per-module access granted by the Owner (see MODULES in enums.ts). Missing module = no access. */
    permissions: jsonb('permissions')
      .$type<MemberPermissions>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('memberships_tenant_id_user_id_key').on(t.tenantId, t.userId),
    check(
      'memberships_role_check',
      sql`${t.role} in ('owner', 'admin', 'staff')`,
    ),
    check(
      'memberships_permissions_check',
      sql`public.is_valid_member_permissions(${t.permissions})`,
    ),
    check(
      'memberships_status_check',
      sql`${t.status} in ('active', 'disabled')`,
    ),
    index('memberships_user_id_idx').on(t.userId),
    // At most one Owner per organization, so an ownership change can never leave two.
    uniqueIndex('memberships_one_owner_idx')
      .on(t.tenantId)
      .where(sql`${t.role} = 'owner'`),
  ],
).enableRLS();

export type Membership = typeof memberships.$inferSelect;
