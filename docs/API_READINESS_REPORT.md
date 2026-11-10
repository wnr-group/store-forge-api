# API Readiness Report

Generated 2026-11-10 on branch `feature/nestjs-api-migration`. Every figure below was measured in this repository, not estimated.

## Summary

| Question | Answer |
|---|---|
| Endpoints identified | **74** (73 migrated features + `GET /health/ready`) |
| Endpoints implemented | **74** |
| Endpoints tested (>= 1 successful end-to-end request) | **74 / 74** (`npm run coverage:routes`) |
| Endpoints documented in Swagger | **74 / 74** (`test/swagger.e2e-spec.ts` asserts it) |
| Unit tests | **105 passed** (11 files) |
| API + database integration tests | **155 passed** (8 files, real migrations + real RLS in PGlite) |
| TypeScript build / typecheck | pass (`nest build`, `tsc --noEmit`) |
| Lint (oxlint, type-aware) | **0 errors, 0 warnings** |
| Formatting (Prettier) | pass |
| Schema drift (Drizzle vs migrated database) | **none** |
| Tested against a real Supabase project | **No** (see Remaining issues) |
| Frontend integration | **Not started**, by instruction |

## Modules

| Module | Endpoints | State |
|---|---:|---|
| health | 2 | Complete |
| public (branding, storefront) | 2 | Complete |
| auth (me, change password) | 2 | Complete. Sign-in / sign-out / refresh stay in the Supabase SDK |
| users | 2 | Complete |
| organizations | 2 | Complete |
| store + uploads | 3 | Complete |
| team (Owner) | 6 | Complete |
| categories | 5 | Complete |
| collections | 6 | Complete |
| products | 8 | Complete |
| inventory | 3 | Complete |
| customers | 5 | Complete |
| analytics (also the dashboard overview) | 1 | Complete |
| platform-admin: organizations | 14 | Complete |
| platform-admin: admins, settings, audit, usage | 13 | Complete |

**Pending modules: none.** Absent on purpose because they do not exist in the original app: sign-up, email verification, invitations, order create/update/delete, subscriptions, billing, integrations ([EXCLUDED_FEATURES.md](EXCLUDED_FEATURES.md)).

## Excluded: template customization

No template endpoint, DTO, Drizzle table or service exists (the Swagger test asserts no path or schema mentions "template"). Two deliberate read-only touch points keep existing data safe: the storage reference check *reads* `store_template_settings`, `templates` and `template_versions` so a file a template still shows is never deleted, and `GET /public/storefronts/:slug` returns the `template` object produced by the existing `get_public_storefront()` function unchanged.

## Supabase Auth compatibility

| Requirement | Result |
|---|---|
| Supabase is the only identity provider; no tokens issued, no passwords or `auth.*` tables duplicated | Yes |
| Access tokens verified: signature (JWKS; HS256 only when `SUPABASE_JWT_SECRET` is set), issuer, audience, expiry, UUID `sub`, `role = authenticated` | Yes, unit + e2e tested (forged key, wrong issuer/audience, `none` alg, anon role, anonymous users, expired) |
| Expired token is distinguishable so a client can refresh and retry | `401 TOKEN_EXPIRED` |
| No email verification, no signup, no extra auth steps | Yes. Accounts are created with `email_confirm: true`; dashboard setting "Confirm email" must be OFF |
| Existing behaviour preserved: provisioned accounts, password change re-verifies the current password | Yes |
| Roles/permissions never trusted from token or request | Yes. A test sends a token claiming `owner`/`platform_admin`; the database answer wins |
| Service-role key limited to the Auth Admin API | Yes (`SupabaseAdminService` only) |

## Authentication and authorization test results

All passing. Highlights (`test/auth-tenancy.e2e-spec.ts`, `src/modules/auth/*.spec.ts`, `src/common/**/*.spec.ts`):

- Missing / malformed / wrong-scheme / forged / expired tokens -> 401 with stable codes (`AUTH_REQUIRED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`).
- Wrong issuer, audience, anon role, anonymous user, non-UUID subject -> 401.
- Read-only member can read but gets 403 on every write; a member with no module access gets 403 on that module; settings stay readable.
- Only the Owner reaches `/team/*`; only a Platform Admin reaches `/platform/*`; a tenant Owner never does; only a super admin changes admins and platform settings; the last super admin can never be removed or demoted.
- Disabled membership and suspended organization grant nothing, and a storefront of a suspended organization disappears.
- Permission matrix (`permissions.spec.ts`) ported 1:1 from `lib/auth/permissions.ts`.

## Tenant isolation test results

All passing (`test/auth-tenancy.e2e-spec.ts`, `test/store-team.e2e-spec.ts`, `test/platform.e2e-spec.ts`):

- Another organization's rows never appear in lists; their ids answer **404** on read, update, delete, duplicate, bulk operations (ignored), stock adjustment and team operations.
- `X-Organization-Id` for an organization the caller does not belong to (or a malformed one) -> `403 ORGANIZATION_ACCESS_DENIED`; it is never silently replaced.
- Cannot attach another organization's category, product, collection, parent category or storage path to your own data.
- Platform Admins can list organizations but get no tenant data (`/products` -> no workspace).
- Defence in depth proved: `schema-compat` test shows a superuser connection is refused by the RLS guard, and `platform_admins`, `platform_settings`, `admin_audit_logs`, `rate_limits` cannot be read or changed even by the application role.

## Database compatibility and migration status

- The schema comes from the Next.js repo's `drizzle/0000`-`0024`, copied to `src/database/migrations` and applied to Supabase on 2026-11-10 with `npm run db:migrate` after the tables had been deleted (one local fix in `0004_app_role.sql`, see its README). **No new migrations were written and the schema is unchanged.** Drizzle definitions of 19 tables are ported (template tables excluded); `findSchemaDrift` compares every table, column, type and nullability against the migrated database: **no drift**. `npm run db:verify-schema` does the same against a live `DATABASE_URL`.
- About 35 existing SQL functions (`platform_*`, `list_tenant_team`, `rate_limit_admin`, `get_public_storefront`, ...) are *called*, not re-implemented, so their rules (last super admin, atomic ownership change, orphan detection, audit redaction, currency lock) stay in one place.
- Transactions: product/variant/image/collection saves, stock changes + ledger, organization provisioning + audit, member add + audit are each one transaction. Auth-user creation (outside Postgres) is compensated by deletion on failure and tested.

## Behaviour that differs from the Next.js app (all deliberate, all tested)

| Change | Why |
|---|---|
| A wrong `X-Organization-Id` is a 403, not a silent fall back to your first organization | An API call must never land in a different organization than it named |
| Membership lookup also requires `status = active` and an active organization | Intent no longer depends on RLS policy details |
| `PATCH` is partial (omitted = unchanged, `null` clears) where the server actions took whole forms | REST semantics; the merged result is validated with the same rules as a create |
| Lists take `page`/`limit` (max 100) instead of a fixed page size of 20 (default stays 20) | Brief requirement |
| Invalid list filters are rejected with 400 instead of silently falling back to defaults | An API client should learn about a typo |
| Tokens are verified locally (JWKS) instead of a `getUser()` round trip | No per-request call to Supabase. A revoked session stays valid until the token expires (default 1 h); disabled/removed members are cut off immediately because membership is read every request |
| Anonymous Supabase users are refused | StoreForge has no anonymous flows |
| Creating a resource returns 201, actions (bulk, transfer, password reset) return 200 | Standard REST |

## Remaining issues

1. **Not exercised against a real Supabase project.** JWKS fetching, the Auth Admin API, Storage signed uploads/list/remove and `signInWithPassword` are covered by fakes at their boundary; the Supabase-side behaviour is as documented, not observed. Run the smoke checklist below against a staging project before relying on it.
2. ~~Login rate limiting is not replicated~~ **Resolved:** `POST /auth/login` now applies the same `rate_limit_login` limits before the password check (see [COOKIE_SESSION_AUTH.md](COOKIE_SESSION_AUTH.md)).
3. **Two transactions per request** (organization resolution, then the work). With the remote pooler (the frontend team measured about 129 ms per round trip) this costs latency. Easy wins when needed: resolve membership inside the service transaction, or cache memberships for a few seconds.
4. **No CI yet**, so nothing enforces running the database-backed tests (they use `src/database/migrations`). The two copies of the migrations (this repo and the Next.js repo) must be kept in step until D-004 is decided.
5. **Open team decisions** from `docs/architecture/overview.md`: D-004 (who owns schema/migrations long term) and D-006 (what finally moves from server actions to this API). This implementation assumes the Next.js repo keeps owning the schema.
6. `GET /health/ready` needs a reachable database; platforms that probe it for liveness would restart the API during a database outage. Use `/health` for liveness.
7. Nothing is committed yet: the work sits uncommitted on the feature branch for review.

## Smoke checklist for a staging Supabase project

1. `npm run db:verify-schema` with the staging `DATABASE_URL` (as `storeforge_app`).
2. Start the API; `GET /api/v1/health/ready` -> `database: up`.
3. Sign in with the Supabase SDK as a Platform Admin; `GET /api/v1/platform/me` -> `super_admin`/`admin`.
4. `POST /api/v1/platform/organizations`, sign in as the new Owner, `GET /api/v1/organizations/current`.
5. `POST /api/v1/uploads/signed-urls`, PUT a PNG to the returned URL, create a product with that path, then delete the product and confirm the file is removed.
6. `POST /api/v1/auth/change-password`, then sign in with the new password.
7. With a second organization's Owner token, send the first organization's id in `X-Organization-Id` -> 403.
