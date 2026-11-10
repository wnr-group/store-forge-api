// GENERATED from wnr-group/store-forge lib/db/schema/template-engine-cutover.ts. DO NOT EDIT.

import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The ONE persisted source of truth for "may the storefront read the template engine?" (cutover gate, option B).
 * A singleton row: status `pending` until `scripts/resync-legacy-templates.ts --apply --activate` has re-synced AND verified every
 * V1 store in one transaction, then `complete`. Fail-closed by construction: the app asks only public.template_engine_cutover_complete(),
 * which is true solely for a well-formed `complete` row; a missing row, an incomplete row, a missing function or any error means closed.
 * No role other than the privileged migration connection can read or write the table (all privileges revoked, no policies).
 */
export const templateEngineCutover = pgTable(
  "template_engine_cutover",
  {
    id: boolean("id").primaryKey().default(true),
    status: text("status", { enum: ["pending", "complete"] }).notNull().default("pending"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Number of V1 stores that were verified when the gate was opened. */
    verifiedStores: integer("verified_stores"),
    /** Outcome counts of the verification (created / resynced / unchanged / skipped_engine_modified / failed). */
    resyncCounts: jsonb("resync_counts"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("template_engine_cutover_singleton_check", sql`${t.id}`),
    check("template_engine_cutover_status_check", sql`${t.status} in ('pending', 'complete')`),
    check("template_engine_cutover_complete_check", sql`${t.status} <> 'complete' or (${t.completedAt} is not null and ${t.verifiedStores} is not null and ${t.verifiedStores} >= 0)`),
  ],
).enableRLS();
