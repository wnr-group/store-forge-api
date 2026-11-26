import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Operational monitoring data (migration 0066). Written only by the monitoring SECURITY DEFINER functions, read by Platform Admins.
 * Holds no request body, header, user or tenant data: the route is a template and the message is sanitised before it is stored.
 */
export const platformErrorEvents = pgTable(
  'platform_error_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    method: text('method').notNull(),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    errorName: text('error_name').notNull(),
    message: text('message').notNull(),
    source: text('source'),
    requestId: text('request_id'),
  },
  (t) => [
    check(
      'platform_error_events_status_check',
      sql`${t.status} between 500 and 599`,
    ),
    index('platform_error_events_occurred_idx').on(t.occurredAt.desc()),
    index('platform_error_events_issue_idx').on(
      t.route,
      t.errorName,
      t.occurredAt.desc(),
    ),
  ],
).enableRLS();

export const platformJobRuns = pgTable(
  'platform_job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    job: text('job').notNull(),
    status: text('status', { enum: ['ok', 'failed'] }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    summary: jsonb('summary').$type<Record<
      string,
      number | boolean | string
    > | null>(),
    error: text('error'),
  },
  (t) => [
    index('platform_job_runs_job_idx').on(t.job, t.startedAt.desc()),
    index('platform_job_runs_started_idx').on(t.startedAt.desc()),
  ],
).enableRLS();

export type PlatformErrorEvent = typeof platformErrorEvents.$inferSelect;
export type PlatformJobRun = typeof platformJobRuns.$inferSelect;
