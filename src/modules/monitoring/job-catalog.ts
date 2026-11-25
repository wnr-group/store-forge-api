/**
 * The scheduled jobs (`/internal/jobs/*`) and how often each is meant to run. The cadences are the ones recommended in
 * docs/COMMERCE_OPERATIONS.md and docs/PLATFORM_BILLING.md; the schedule itself lives in the hosting platform's cron settings, which
 * this application cannot see. A job is only called late once it HAS run and then stopped, so a job nobody scheduled shows as
 * "never run" instead of raising a false alarm.
 */
export const JOBS = {
  'expire-reservations': {
    label: 'Release expired stock holds',
    everyMinutes: 5,
  },
  'reconcile-payments': {
    label: 'Reconcile shopper payments',
    everyMinutes: 15,
  },
  'sync-shipments': { label: 'Refresh shipment tracking', everyMinutes: 20 },
  'purge-abandoned-carts': {
    label: 'Purge old abandoned carts',
    everyMinutes: 24 * 60,
  },
  billing: {
    label: 'Subscription renewals and overdue billing',
    everyMinutes: 24 * 60,
  },
} as const;

export type JobName = keyof typeof JOBS;
export const JOB_NAMES = Object.keys(JOBS) as JobName[];
export const isJobName = (v: unknown): v is JobName =>
  typeof v === 'string' && v in JOBS;

/** A job is late when its last success is older than this many times its cadence (plus a few minutes of slack). */
export const LATE_FACTOR = 2;
export const LATE_SLACK_MINUTES = 5;
