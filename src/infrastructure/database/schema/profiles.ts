// GENERATED from wnr-group/store-forge lib/db/schema/profiles.ts. DO NOT EDIT.

import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { sql } from "drizzle-orm";

/**
 * Application-level user data. `id` is the Supabase Auth user id.
 * `auth.users` is owned by Supabase and is only *referenced* here
 * (drizzle.config.ts restricts schemaFilter to "public").
 * Rows are created by the on_auth_user_created trigger, never by the client.
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("profiles_full_name_check", sql`${t.fullName} is null or char_length(${t.fullName}) <= 120`)],
).enableRLS();

export type Profile = typeof profiles.$inferSelect;
