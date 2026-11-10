import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Fixed-window counters behind rate limiting (see lib/security/rate-limit.ts). Shared by every server instance, so limits hold
 * on serverless hosting where in-memory counters would not. A row is one subject in one window; old windows are deleted as a side
 * effect of use. No grants and no policies: only rate_limit_admin() and rate_limit_login() touch it.
 *
 * `key` is `<bucket>:<admin user id>` for admin operations and `login:<kind>:<hash>` for sign-in attempts. The hash is an HMAC of the
 * address and e-mail, so no raw address or e-mail is stored here.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'rate_limits_pkey', columns: [t.key, t.windowStart] }),
  ],
).enableRLS();
