# Platform administration: security verification

Each requirement of the brief, the control that provides it, and the test that fails if it stops being true. Test files are under `test/`.

| Requirement | Control | Proved by |
|---|---|---|
| Only platform admins reach the Platform Admin APIs | Global `JwtAuthGuard`, then `PlatformAdminGuard`; the role is read from `platform_admins` in the database on every request, never from token claims | `platform-security-matrix`: every one of the 63 platform routes answers 401 without a session and 403 to a store owner and to a person with no organization |
| A route cannot be added without an access rule | The matrix test reads the router and fails if any `/platform` route has no `@PlatformAccess` metadata or is public | `platform-security-matrix` "is found, is protected, and is never public" |
| Role matrix (Super, Platform, Billing, Support) | `common/constants/platform-permissions.ts` + guard; routes without a declared permission stay operator-only | `platform-security-matrix` (each role against each route, allowed and denied); `platform-rbac`; unit spec |
| The matrix holds even if an API route is wrong | Migration 0067: `platform_*` functions and platform tables check the role in SQL | `platform-hardening` (calls the functions and tables directly as each role) |
| Store owners get no platform power; platform roles cannot be assigned through tenant APIs | Separate tables and guards; team requests reject unknown fields; `platform_add_admin` / `platform_set_admin_role` are super-admin-only; a trigger keeps a platform admin out of every organization | `platform-hardening` "platform roles cannot be reached through tenant APIs" |
| Tenant data stays isolated | Row level security on every table; new billing, plan and entitlement tables are readable only by the roles above and an Owner reads only its own invoices | `billing` "data protection", `entitlements` "what a tenant sees about itself", `platform-hardening` tables |
| Usage limits cannot be bypassed | Checked in the inserting transaction under a per-tenant lock, on every create path (form, duplicate, bulk import, staff, uploads) | `entitlements` (including a race of five simultaneous requests), `platform-hardening` bulk import |
| Entitlements are checked on the backend | `@RequireFeature` guard and service checks; the storefront follows the plan | `entitlements` (every gated route, plan change, override, SQL/API agreement) |
| Razorpay signatures, webhooks and idempotency | Checkout signature then a lookup at Razorpay; webhook signature over the raw bytes; one row per event id; unique order and payment ids | `billing` (forged, wrong and missing signatures, replays, amount mismatch, late payments) |
| Audit logs cannot be tampered with | Append-only triggers, no grants, write only through a platform-admin function; credentials stripped | `audit-logs` (update, delete and truncate rejected for every role including the table owner) |
| Sensitive information is never exposed | No route returns a key or secret; error and job messages are sanitised before storage | `platform-security-matrix` scans every platform list for the configured secrets, tokens and secret-looking field names; `monitoring`; `billing` |
| Suspension is enforced consistently | Suspended tenants are invisible to every membership check and to the public store functions | `platform-security-matrix` calls **every** tenant route and every public store route for a suspended organization (and the same sweep on an active one as a control) |
| Denied attempts leave a trace | Refused platform requests are logged with user id, route, reason and request id | `audit-logs` "leaves a line in the server log" |

## Defence in depth, in layers

1. Authentication: Supabase JWT verified on every request.
2. Platform guard: role from the database, then the permission the route declares.
3. Database functions and policies: the same matrix again (0067), so the API is not the only line.
4. Rate limits on sensitive platform actions (per admin, counted in the database).
5. Audit: every change is recorded in its own transaction.

## Residual risks and limits

* **The application connects to the database as one role.** Row level security and the role checks protect against bugs in the API, not against
  someone who holds the application's database credentials. Keep `DATABASE_URL` secret and rotate it if exposed.
* **Platform Razorpay keys live in the server environment.** Anyone who can read the host's environment can read them. Use a restricted key
  where Razorpay allows it, and rotate on staff changes.
* **Tenant-side "admin" accounts created by a platform admin start with a password the admin chose.** There is no invitation e-mail because no
  e-mail provider is configured; the Owner should change the password at first sign-in.
* **Not tested against a real Supabase or PostgreSQL.** All tests run on PGlite with a stubbed Supabase. Run `npm run db:migrate` against a
  staging database and repeat the checks in the checklist below before production.
* **Support can see tenant names, owner e-mail and subscription state.** That is the point of the role; remove `tenants:read` from it in
  `platform-permissions.ts` if you want less.
* **Search uses `ILIKE '%term%'`** on tenant, invoice and error text. It is fine for thousands of rows; at much larger scale add a trigram index.

## Before going live

1. `npm run db:migrate` on staging, then `npm run db:verify-schema`.
2. Create the first Super Admin with `npm run admin:create`; create the other roles from the dashboard.
3. Set `RAZORPAY_PLATFORM_KEY_ID`, `RAZORPAY_PLATFORM_KEY_SECRET`, `RAZORPAY_PLATFORM_WEBHOOK_SECRET`, `CRON_SECRET`; point Razorpay's webhook at
   `/api/v1/webhooks/billing/razorpay`.
4. Schedule the five jobs (see `docs/PLATFORM_MONITORING.md`) and confirm each shows a run on the Monitoring screen.
5. Review the seeded "Legacy" plan: every existing tenant is on it (all features, no limits). Create real plans, make one the default, and
   move tenants over deliberately.
6. Set the billing settings (legal name, GSTIN, tax rate) before the first invoice; issued invoices keep what they were issued with.
7. Test one payment end to end with Razorpay test keys, including a refund and a webhook redelivery.
