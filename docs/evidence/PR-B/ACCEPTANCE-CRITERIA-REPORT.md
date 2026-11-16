# Acceptance Criteria Report: PR-B Security Foundation

## 1. Executive Summary
- **Target:** PR-B (*Security, API Contracts, Readiness, Rate Limiting and Auth Test Kit*, tasks B1–B11, AC-B-01 through AC-B-99)
- **Branch:** `feat/foundation-security` (worktree `store-forge-api-prb`)
- **Status:** **READY FOR REVIEW**
  - **97 Acceptance Criteria PASS** (93 automated test-verified, 2 browser screenshot-verified, 2 CI/harness-verified)
  - **1 Acceptance Criteria BLOCKED:** AC-B-22 (Gate G-JWT: requires hosted Supabase session token)
  - **1 Acceptance Criteria NOT VERIFIED:** AC-B-23 (Gate G-LIVE: requires destructive actions on real Supabase account)
  - **Gate G-DRIFT:** BLOCKED (pending `STORE_FORGE_READ_TOKEN` GitHub repository secret)

## 2. Test Execution Summary
| Suite | Files | Tests | Passed | Failed | Duration | Environment |
|---|---|---|---|---|---|---|
| Unit (`npm test`) | 8 | 96 | 96 | 0 | ~1.5s | Node v24.18.0 / Vitest 4.1.12 |
| Integration (`npm run test:int`) | 6 | 80 | 80 | 0 | ~23s | PGlite 0.2.14 / Ephemeral DB |
| E2E (`npm run test:e2e`) | 4 | 43 | 43 | 0 | ~8s | Supertest / Express / PGlite |
| **Total** | **18** | **219** | **219** | **0** | **~33s** | **100% Green** |

## 3. Browser Screenshots (Category A)
Real Swagger UI screenshots captured via headless Chromium without adding Playwright to `package.json`:
1. **AC-B-95 (`GET /api/v1/health` & `GET /api/v1/health/ready`):**
   - Path: `screenshots/store-forge-api/PR-B/swagger/AC-B-95_swagger-ui-health-public.png`
   - Result: Renders public endpoints with `[public]` marker, no lock icon, and correct HTTP response codes (200 / 503).
2. **AC-B-96 (`GET /api/v1/probe/tenant-protected`):**
   - Path: `screenshots/store-forge-api/PR-B/swagger/AC-B-96_swagger-ui-probe-auth-tenant.png`
   - Result: Renders Bearer lock icon, explicit `X-Tenant-Id` header parameter (UUID), required permission badge, and standard `ErrorResponseDto` 400/401/403/500 schemas.

## 4. Architectural Boundaries and Decisions
- **Zero SQL / Zero Migrations:** The database schema snapshot strictly ends at `0024` (PR-A). No new migrations, tables, triggers, policies, or grants were created in PR-B.
- **Global Guard Pipeline Order:** Six independent NestJS guards registered globally in strict order:
  `AuthGuard` -> `TenantGuard` -> `PlatformAdminGuard` -> `SuperAdminGuard` -> `PermissionGuard` -> `LiveAuthGuard`.
- **Tenant Context Isolation:** `DatabaseService.withTenant({ tenantId, userId }, callback)` re-resolves the user's active membership inside the transaction, guaranteeing race-condition-free RLS isolation.
- **Rate Limiting & Fail-Open Resilience:** In-process rate limiting via `@nestjs/throttler`. When memory storage or database checks encounter an error, limiters fail OPEN with an error log, preserving system availability.
- **Unified Error Envelope:** All exceptions return `{ statusCode, error, message, path, timestamp, code, fieldErrors? }`. Native NestJS errors are mapped to corresponding error codes.

## 5. Traceability Matrix: All 99 Acceptance Criteria

| AC ID | Requirement | Implementation | Category | Evidence | Status |
|---|---|---|---|---|---|
| AC-B-01 | Valid ES256 token accepted; `userId` = `sub` | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-02 | HS256 token signed with the public key material rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-03 | `alg: none` rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-04 | Tampered signature rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-05 | Wrong issuer rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-06 | Wrong audience rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-07 | Expired token rejected (and one second before/after `exp`) | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-08 | Non-UUID `sub` rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-09 | `role` `anon` and `service_role` rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-10 | Missing or malformed `Authorization` gives 401 `UNAUTHENTICATED` | `auth/auth.guard` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-11 | Unknown `kid` triggers a JWKS refetch; rotated key then accepted | `auth/jwks.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-12 | Persistently unknown `kid` rejected | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-13 | JWKS unreachable and nothing cached: rejected (fail closed) | `auth/jwks.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-14 | Cached key still verifies during a brief JWKS outage | `auth/jwks.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-15 | Repeated unknown `kid` refetches at most once per cooldown | `auth/jwks.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-16 | Ordinary authenticated reads make zero `/auth/v1/user` calls | `auth/live-auth.guard` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-17 | `@RequireLiveAuth` passes for a valid user | `auth/live-auth.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-18 | Invalid, deleted or disabled user (401, 403, id mismatch) rejected | `auth/live-auth.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-19 | Supabase timeout or network error fails closed | `auth/live-auth.service` | A auth | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-20 | Protected handler spy never called when the live check fails | `auth/live-auth.guard` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-21 | `expectLiveAuthRequired(route)` fails for an undecorated route | `test/support` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-22 | Real token metadata matches D-008 (G-JWT) | `scratch script` | C | N/A | **BLOCKED** |
| AC-B-23 | Real Supabase behaviour for a banned or deleted user | `n/a` | C | N/A | **NOT VERIFIED** |
| AC-B-24 | Missing `X-Tenant-Id` gives 400 | `auth/tenant.guard` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-25 | Malformed UUID gives 400 | `auth/tenant.guard` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-26 | Valid UUID, no membership gives 403 | `auth/tenant-access.service` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-27 | 403 body identical for a non-existent tenant and another user's tenant | `auth/tenant-access.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-28 | Disabled membership gives 403 | `auth/tenant-access.service` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-29 | Suspended tenant gives 403 | `auth/tenant-access.service` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-30 | User with two tenants: requested tenant used, not the first | `auth/tenant-access.service` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-31 | Stale or incorrect id gives 403, never a fallback | `auth/tenant-access.service` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-32 | Tenant in body, query or JWT claim ignored | `auth/tenant.guard` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-33 | Handler spy not called after any tenant validation failure | `auth/tenant.guard` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-34 | `withTenant` yields `tenantId`, `userId`, `role` | `database/database.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-35 | Membership removed after the guard but before `withTenant` gives 403 | `database/database.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-36 | `@RequirePermission` allows and denies per `can()` incl. per-module levels | `auth/permission.guard, generated/permissions` | A permissions | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-37 | Authenticated route without `@NoTenant()` requires the header; `@NoTenant()` does not | `auth/tenant.guard` | A tenant | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-38 | RLS alone isolates tenants (no-filter probe query) | `existing RLS` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-39 | Seven codes map to exact statuses | `common/errors` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-40 | Five original error fields still present | `filters/all-exceptions.filter` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-41 | `fieldErrors` only when provided | `common/errors` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-42 | Validation failure gives property to first message, nested keys dotted | `app.setup exceptionFactory` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-43 | Unexpected error gives generic 500 `UNKNOWN`, no thrown text, SQL or stack | `filters/all-exceptions.filter` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-44 | Logs contain no body, `Authorization`, cookie or query string | `filters/all-exceptions.filter` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-45 | Native Nest exceptions (404, malformed JSON 400) get the right `code` | `filters/all-exceptions.filter` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-46 | Success responses are bare DTOs | `probe + contracts` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-47 | 200 read, 201 create, 204 delete (empty body) | `probe + contracts` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-48 | Paged body has exactly `items, total, page, pageSize` | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-49 | Defaults `page=1`, `pageSize=20` | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-50 | Sizes 10, 20, 50, 100 accepted | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-51 | Invalid `pageSize` (15, 0, -1, `abc`, 101, 20.0) gives 400 + `fieldErrors.pageSize`, no clamping | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-52 | Invalid `page` (0, -1, 1.5, `x`, 2^53) gives 400 + `fieldErrors.page` | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-53 | camelCase keys and ISO 8601 dates | `common/dto` | A api-contracts | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-54 | Liveness 200 with no DB access; payload `{status, service}` | `modules/health` | A health | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-55 | Readiness 200 `{ "status": "ok" }` when `select 1` succeeds | `modules/health` | A readiness | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-56 | Readiness 503 exactly `{ "status": "unavailable" }` when the DB is down | `modules/health` | A readiness | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-57 | Readiness honours the configured timeout | `modules/health` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-58 | Readiness body has no host, ref, role, password or SQL error | `modules/health` | A readiness | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-59 | Unsafe role makes readiness `unavailable` (existing `ping()` check) | `database/database.service` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-60 | Readiness has its own limit: N+1 gives 429 with `Retry-After` | `common/rate-limit` | A rate-limiting | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-61 | Readiness and public buckets independent in both directions | `common/rate-limit` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-62 | Below the limit succeeds | `common/rate-limit` | A rate-limiting | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-63 | Over the limit gives 429 `RATE_LIMITED` | `common/rate-limit` | A rate-limiting | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-64 | Five probe routes share one bucket | `common/rate-limit` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-65 | Different client IPs get separate buckets (`TRUST_PROXY=1`) | `common/rate-limit` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-66 | `Retry-After` is an integer within the window and decreases | `common/rate-limit` | A rate-limiting | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-67 | `TRUST_PROXY` disabled by default: `X-Forwarded-For` ignored | `app.setup` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-68 | `TRUST_PROXY=1` resolves the expected client IP | `app.setup` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-69 | Client-supplied leftmost `X-Forwarded-For` entries cannot bypass the limit | `common/rate-limit/client-ip` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-70 | Limiter storage error fails open and is logged | `common/rate-limit` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-71 | Limit and window from env; invalid `TRUST_PROXY` (-1, 1.5, `abc`) rejected | `config` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-72 | Docs state limitations and the OPEN topology | `docs` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-73 | Each of the 7 buckets keeps its exact limit and 600 s window | `security/admin-rate-limit.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-74 | Two admins have independent counters | `security/admin-rate-limit.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-75 | Limiter or DB error fails open and logs | `security/admin-rate-limit.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-76 | Audit row committed atomically with the mutation (same `tx`) | `security/audit.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-77 | Failed mutation leaves no audit row | `security/audit.service` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-78 | Audit table rejects update and delete | `existing SQL trigger` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-79 | Non-platform-admin rejected by guard | `auth/platform-admin.guard` | A platform-security | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-80 | Platform admin rejected on a super-admin-only route | `auth/super-admin.guard` | A platform-security | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-81 | DB-side authorization holds with the guard bypassed (direct SQL as non-admin) | `existing SQL functions` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-82 | `AUTH_TEST_JWKS` outside `NODE_ENV=test` fails startup naming the variable | `config` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-83 | Helper tokens pass the same verification path as real tokens | `test/support/auth` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-84 | Bad-signature and bad-claim helper tokens rejected | `test/support/auth` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-85 | `createTestApp` runs the production pipeline | `test/support/create-test-app` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-86 | Test private key never written to disk or logged | `test/support/auth` | B | [full-int-results.json](screenshots/store-forge-api/PR-B/test-output/full-int-results.json) | **PASS** |
| AC-B-87 | Whole suite runs with no hosted credentials | `CI + local` | C | [full-suite-summary.json](screenshots/store-forge-api/PR-B/test-output/full-suite-summary.json) | **PASS** |
| AC-B-88 | Startup fails on project-ref mismatch; skip with warning when a ref is not derivable | `config/project-ref` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-89 | Swagger starts; `/api/docs` and `/api/docs-json` respond | `common/swagger` | A swagger | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-90 | Generated spec is valid OpenAPI | `common/swagger` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-91 | Every registered controller route appears in the spec (route inventory) | `test/support/route-inventory` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-92 | Public routes no security; authenticated Bearer; tenant routes list `X-Tenant-Id` and `x-permission` | `common/swagger/api-decorators` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-93 | Health and probe responses validate against published schemas (`ajv`) | `common/swagger` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-94 | Error and paged schemas documented once and referenced; `page`/`pageSize` documented | `common/swagger` | B | [full-e2e-results.json](screenshots/store-forge-api/PR-B/test-output/full-e2e-results.json) | **PASS** |
| AC-B-95 | Swagger UI renders in a real browser showing both health routes with the public marker | `scratch Playwright` | A swagger | [AC-B-95_swagger-ui-health-public.png](screenshots/store-forge-api/PR-B/swagger/AC-B-95_swagger-ui-health-public.png) | **PASS** |
| AC-B-96 | Swagger UI shows Bearer lock, `X-Tenant-Id` header and error schema on a probe route (labelled PROBE) | `scratch Playwright` | A swagger | [AC-B-96_swagger-ui-probe-auth-tenant.png](screenshots/store-forge-api/PR-B/swagger/AC-B-96_swagger-ui-probe-auth-tenant.png) | **PASS** |
| AC-B-97 | Existing e2e and unit suites pass after intentional updates | `CI + local` | C | [full-suite-summary.json](screenshots/store-forge-api/PR-B/test-output/full-suite-summary.json) | **PASS** |
| AC-B-98 | Docs state Next.js forwarding requirements | `docs` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |
| AC-B-99 | Docs record the deliberate `pageSize` difference from the frontend | `docs` | B | [full-unit-results.json](screenshots/store-forge-api/PR-B/test-output/full-unit-results.json) | **PASS** |

## 6. Gate Status and Blockers
- **Gate G-JWT (AC-B-22) - BLOCKED:**
  - *Requirement:* Live inspection of a real Supabase session JWT to verify `alg: "ES256"`, `iss: "${SUPABASE_URL}/auth/v1"`, `aud: "authenticated"`, `sub: "<uuid>"`.
  - *Blocker:* No active hosted Supabase user session token is present in the development environment.
  - *Next Action:* Eshwar to provide an active session token or run the token verification probe once hosted Supabase credentials are wired.
- **Gate G-DRIFT - BLOCKED:**
  - *Requirement:* GitHub Actions CI workflow drift check against `wnr-group/store-forge`.
  - *Blocker:* Repository secret `STORE_FORGE_READ_TOKEN` is not configured in `wnr-group/store-forge-api`.
  - *Next Action:* Eshwar/Repo Admin to add `STORE_FORGE_READ_TOKEN` with read access to `wnr-group/store-forge`.
- **Gate G-LIVE (AC-B-23) - NOT VERIFIED:**
  - *Requirement:* Verify live user ban/delete behavior directly against hosted Supabase Auth Admin.
  - *Status:* Preserved as NOT VERIFIED to avoid non-reproducible manual claims. Automated mock and timeout behavior fully verified in `live-auth.int-spec.ts`.

## 7. Sanitization Verification
All generated files under `screenshots/store-forge-api/PR-B/` were scanned with regex patterns detecting JWTs (`eyJ`), database URLs (`postgres://`), Supabase keys (`sb_*`, `apikey`), access/refresh tokens, and authorization headers.
**Result: 100% CLEAN (0 secrets detected).**
