// GENERATED from wnr-group/store-forge lib/db/schema/store-template-settings.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { stores } from "./stores.js";

/**
 * One row per store: the selected template and its customization. A missing row means the default
 * template with no customization. `tenant_id` is part of a composite FK so a row can never point at
 * another tenant's store. Values are checked here as well as in the app (same rules).
 */
export const storeTemplateSettings = pgTable(
  "store_template_settings",
  {
    storeId: uuid("store_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    templateKey: text("template_key").notNull(),
    accentColor: text("accent_color"),
    heroHeading: text("hero_heading"),
    heroSubheading: text("hero_subheading"),
    /** Object path in the `products` bucket (`{tenant_id}/store/...`), not a URL. */
    heroImagePath: text("hero_image_path"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.storeId], foreignColumns: [stores.tenantId, stores.id], name: "store_template_settings_store_fk" }).onDelete("cascade"),
    check("store_template_settings_template_key_check", sql`${t.templateKey} ~ '^[a-z][a-z0-9-]{1,39}$'`),
    check("store_template_settings_accent_color_check", sql`${t.accentColor} is null or ${t.accentColor} ~ '^#[0-9a-f]{6}$'`),
    check("store_template_settings_hero_heading_check", sql`${t.heroHeading} is null or char_length(btrim(${t.heroHeading})) between 1 and 80`),
    check("store_template_settings_hero_subheading_check", sql`${t.heroSubheading} is null or char_length(btrim(${t.heroSubheading})) between 1 and 200`),
    check(
      "store_template_settings_hero_image_path_check",
      sql`${t.heroImagePath} is null or (${t.heroImagePath} like ${t.tenantId}::text || '/store/%' and ${t.heroImagePath} !~ '\\.\\.')`,
    ),
  ],
).enableRLS();

export type StoreTemplateSettingsRow = typeof storeTemplateSettings.$inferSelect;
