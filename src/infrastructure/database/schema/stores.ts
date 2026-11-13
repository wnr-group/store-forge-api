// GENERATED from wnr-group/store-forge lib/db/schema/stores.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { SLUG_PATTERN, STORE_STATUSES } from "./enums.js";
import { tenants } from "./tenants.js";

/** A storefront. A tenant may own several; `slug` is globally unique (future subdomain). */
export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Object path of the logo in the `products` bucket (`{tenant_id}/store/...`), not a URL. */
    logoUrl: text("logo_url"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    currency: text("currency").notNull().default("INR"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    status: text("status", { enum: STORE_STATUSES }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("stores_slug_key").on(t.slug),
    unique("stores_tenant_id_id_key").on(t.tenantId, t.id),
    check("stores_name_check", sql`char_length(btrim(${t.name})) between 2 and 80`),
    check("stores_slug_check", sql`${t.slug} ~ ${sql.raw(`'${SLUG_PATTERN}'`)}`),
    check("stores_description_check", sql`${t.description} is null or char_length(${t.description}) <= 500`),
    check("stores_contact_email_check", sql`${t.contactEmail} is null or (char_length(${t.contactEmail}) <= 254 and position('@' in ${t.contactEmail}) > 1)`),
    check("stores_contact_phone_check", sql`${t.contactPhone} is null or char_length(${t.contactPhone}) between 4 and 32`),
    check("stores_logo_path_check", sql`${t.logoUrl} is null or ${t.logoUrl} like ${t.tenantId}::text || '/store/%'`),
    check("stores_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("stores_status_check", sql`${t.status} in ('active', 'inactive', 'suspended')`),
    index("stores_tenant_id_idx").on(t.tenantId),
  ],
).enableRLS();

export type Store = typeof stores.$inferSelect;
