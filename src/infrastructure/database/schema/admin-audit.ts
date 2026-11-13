// GENERATED from wnr-group/store-forge lib/db/schema/admin-audit.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only record of Platform Admin actions. Nothing can read or write it directly (no grants, no policies):
 * rows are written only by public.platform_record_audit() and read only by public.platform_list_audit(), both of
 * which require a Platform Admin. A trigger rejects every UPDATE, DELETE and TRUNCATE, so history cannot be edited.
 *
 * `admin_user_id` and `organization_id` are deliberately NOT foreign keys: the log must outlive a deleted admin account
 * or organization, so the e-mail and organization name are copied into the row at the time of the action.
 * Passwords, tokens and similar keys are stripped from `previous_data` / `new_data` by public.audit_redact().
 */
export const ADMIN_AUDIT_ENTITY_TYPES = ["organization", "store", "team_member", "platform_admin", "support_note", "platform_settings"] as const;
export type AdminAuditEntityType = (typeof ADMIN_AUDIT_ENTITY_TYPES)[number];

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminUserId: uuid("admin_user_id").notNull(),
    adminEmail: text("admin_email").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    organizationId: uuid("organization_id"),
    organizationName: text("organization_name"),
    description: text("description").notNull(),
    previousData: jsonb("previous_data"),
    newData: jsonb("new_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("admin_audit_logs_action_check", sql`${t.action} ~ '^[a-z_]+\.[a-z_]+$'`),
    check("admin_audit_logs_entity_type_check", sql`${t.entityType} in ('organization', 'store', 'team_member', 'platform_admin', 'support_note', 'platform_settings')`),
    check("admin_audit_logs_description_check", sql`char_length(${t.description}) between 1 and 500`),
    index("admin_audit_logs_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("admin_audit_logs_org_idx").on(t.organizationId, t.createdAt.desc()),
    index("admin_audit_logs_admin_idx").on(t.adminUserId, t.createdAt.desc()),
    index("admin_audit_logs_action_idx").on(t.action, t.createdAt.desc()),
  ],
).enableRLS();

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
