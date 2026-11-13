// GENERATED from wnr-group/store-forge lib/db/schema/platform-settings.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Platform-wide settings that used to be hardcoded. Exactly one row (`id` is always true). No grants and no policies:
 * read through get_platform_settings() (admins) or get_public_platform_settings() (name and support e-mail only),
 * written only by platform_update_settings() (super admins). Nothing secret belongs here.
 *
 * Defaults for currency, timezone and store status are applied when an organization is created.
 */
export const platformSettings = pgTable(
  "platform_settings",
  {
    id: boolean("id").primaryKey().default(true),
    platformName: text("platform_name").notNull().default("StoreForge"),
    supportEmail: text("support_email"),
    defaultCurrency: text("default_currency").notNull().default("INR"),
    defaultTimezone: text("default_timezone").notNull().default("Asia/Kolkata"),
    defaultStoreStatus: text("default_store_status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    check("platform_settings_singleton_check", sql`${t.id}`),
    check("platform_settings_name_check", sql`char_length(btrim(${t.platformName})) between 2 and 60`),
    check("platform_settings_support_email_check", sql`${t.supportEmail} is null or (char_length(${t.supportEmail}) <= 254 and position('@' in ${t.supportEmail}) > 1)`),
    check("platform_settings_currency_check", sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    check("platform_settings_store_status_check", sql`${t.defaultStoreStatus} in ('active', 'inactive')`),
  ],
).enableRLS();

export type PlatformSettings = typeof platformSettings.$inferSelect;
