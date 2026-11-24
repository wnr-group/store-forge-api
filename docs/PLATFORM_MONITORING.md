# Platform monitoring

`GET /platform/monitoring/overview` (with `/errors` and `/jobs` for detail) feeds the System Monitoring screen. It needs the
`monitoring:read` permission: Super Admin and Platform Admin. It is built to be **polled** (every 30 seconds is plenty); there is no
WebSocket or other push channel, on purpose.

## Three kinds of number, never mixed up

| Kind | What | How it is obtained |
|---|---|---|
| **Measured now** | Database round trip and latency; the sign-in service (Supabase Auth `/auth/v1/health`, 3 s timeout, cached 15 s so polling cannot hammer it) | A real call on every request |
| **Counted from records** | Server errors (HTTP 5xx) of the last 15 minutes and 24 hours, per hour, and the most frequent; every run of every scheduled job | `platform_error_events`, `platform_job_runs` (migration 0066) |
| **Read from configuration** | Whether the platform Razorpay keys, the webhook secret and `CRON_SECRET` are set | Presence only; values are never returned |

Anything the system does not measure is listed under `unavailableMetrics` with the reason (CPU and memory on serverless, request latency,
4xx responses, queues, Razorpay and carrier availability). It is never shown as zero.

Service status values: `up` / `down` were measured just now; `not_configured` means the server has no setting for it; `not_checked`
means it is configured but this screen does not call it (Razorpay, the scheduler: a job run proves more than a setting does).

## Server errors

The exception filter records every unhandled 5xx (not the expected `503`s that explain themselves, not 4xx). A row holds: method, the route
**template** (`/api/v1/products/:id`, never the URL or query string), status, the error class, a sanitised message, the first application
line of the stack, and the request id (`X-Request-Id`, which is also in the server log and the audit log).

The message is sanitised before it is stored: the database driver's "Failed query ... params" text becomes `Database query failed`; ids,
e-mail addresses, tokens, Razorpay keys, long numbers and long quoted text become placeholders; only the first line is kept, 300 characters at
most. No request body, header, cookie, user or tenant is stored. Clients still receive only the generic message.

Bounds: rows older than 14 days are removed, at most 200 are recorded per minute (an outage cannot flood the table), and the write is
awaited with a 1.5 s limit before the answer is sent (a serverless function may be frozen after it) but can never make a request fail.
**When the database itself is down nothing can be recorded**; the overview then says so (an `error-records-unavailable` or
`database-down` alert) instead of showing a calm 0.

## Scheduled jobs

The five scheduler routes (`/internal/jobs/expire-reservations`, `reconcile-payments`, `sync-shipments`, `purge-abandoned-carts`,
`billing`) record each run: start, duration, ok or failed, a small numeric summary (counts only) or the sanitised error. A call refused for a
wrong or missing secret records nothing. Runs older than 30 days are removed.

Health per job: `failing` (the last run failed), `late` (it has run before but has had no success for more than twice its interval plus 5
minutes), `ok`, or `never_run`. The intervals are the ones recommended in `docs/COMMERCE_OPERATIONS.md` and `docs/PLATFORM_BILLING.md`
(5, 15, 20 minutes and daily); the real schedule is in the hosting platform's cron settings, which the application cannot see. **A job that
was never scheduled shows as `never_run` and raises no alert**, so there are no false alarms, but also no alarm for a job nobody set up:
check that list after go-live.

## Alerts

Computed on each request from the measurements above, critical first: database down, sign-in service down, 5+ server errors in 15 minutes
(warning) and 25+ (critical), error records unreadable, a failing or late job, billing webhooks that failed in the last 24 hours, refunds
pending over an hour, paid subscriptions while the platform Razorpay keys are missing, and scheduled jobs disabled (`CRON_SECRET` unset).
Alerts are not stored, sent or acknowledged: they exist while the condition does. There is no e-mail or chat notification.
