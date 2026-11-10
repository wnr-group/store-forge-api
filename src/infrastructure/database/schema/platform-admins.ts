// GENERATED from wnr-group/store-forge lib/db/schema/platform-admins.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { PLATFORM_ADMIN_ROLES } from "./enums.js";

/**
 * StoreForge Platform Admins. Deliberately separate from `memberships`/roles: tenant
 * roles never imply platform authority. No privileges are granted to anon/authenticated
 * and there are no policies, so the table is unreachable from the API; rows are added
 * only by the privileged `npm run admin:create` script. The app asks "am I an admin?"
 * through public.is_platform_admin(), which reads auth.uid() only.
 */
export const platformAdmins = pgTable(
  "platform_admins",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /** `super_admin` manages other admins and the platform settings; `admin` does everything else. */
    role: text("role", { enum: PLATFORM_ADMIN_ROLES }).notNull().default("admin"),
    /** The admin who added this one. Not a foreign key: the history survives that admin's removal. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("platform_admins_role_check", sql`${t.role} in ('super_admin', 'admin')`)],
).enableRLS();

export type PlatformAdmin = typeof platformAdmins.$inferSelect;
