# Architecture overview

## Scope of this document

What exists today, how the backend is structured, decision register D-001 through D-025, schema ownership, and architectural boundaries.

## Next.js caller convention and forwarding requirements (D-003, D-009, D-020)

> **Important architectural boundary:**
> Next.js is the intended caller; direct API access is not technically prevented; valid user tokens work from any client; user authentication, authorization and RLS are the real security boundaries; public endpoints need separate abuse protection.

### Next.js header forwarding contract (AC-B-98)
Next.js server components and server actions calling `store-forge-api` must forward client credentials:
1. `Authorization: Bearer <token>`: The user's Supabase session JWT (ES256), forwarded from the client session.
2. `X-Tenant-Id: <uuid>`: The active tenant UUID, forwarded on all multi-tenant endpoints.
3. Errors returned by the API adhere to the unified error envelope `{ statusCode, error, message, path, timestamp, code, fieldErrors? }`.

## System overview and repository split

- **Frontend:** [`wnr-group/store-forge`](https://github.com/wnr-group/store-forge). Single source of truth for the database schema and migrations.
- **Backend:** `store-forge-api`. Dedicated NestJS modular-monolith providing scalable API services, security guards, database integration, and provisioning.

## Database and multi-tenant isolation (D-010, D-011, D-016, D-020)

- Single project: `xrkwyjnjemyxrbdbfmcn` only.
- Connecting role: `storeforge_app` only. No `postgres` owner URL, no `DIRECT_URL`, no service-role key for database access.
- Ported per-request pattern (`withUserContext` / `withPublicContext`):
  1. Opens transaction.
  2. Sets `request.jwt.claims` locally with verified identity (`sub` and `role = authenticated`).
  3. `SET LOCAL ROLE authenticated` so RLS policies are enforced.
  4. RLS guard asserts the role switch took effect and the connection cannot bypass RLS.
- Database access is encapsulated in `DatabaseModule` (`src/infrastructure/database`).
- `DatabaseService.withTenant({ tenantId, userId }, async (tx, ctx) => { ... })` re-resolves the user's active membership inside the work transaction (defending against race conditions) before calling the handler.

### Local testing and PGlite limits (D-018, D-025)

The database test kit runs tests using PGlite (`@electric-sql/pglite`) and an ephemeral socket server (`@electric-sql/pglite-socket`), applying snapshot migrations over a Supabase stub.

> **PGlite limits:**
> Tests using PGlite have limitations: no real pooler behaviour, no multi-instance rate limiting, and no genuine concurrent isolation. PGlite results do not prove hosted-Supabase compatibility. Hosted Supabase verification is tracked via Gate G-LIVE.

## Security architecture and guard pipeline (D-008, D-020, D-024)

Every request to the API passes through six global NestJS guards registered in a strict, fixed order:
1. `AuthGuard`: Verifies ES256 Supabase JWT against project JWKS (`/.well-known/jwks.json`). `@Public()` bypasses this check. Attaches `request.auth = { userId }`.
2. `TenantGuard`: Enforces `X-Tenant-Id` header (valid UUID) on all authenticated routes by default. Opt-out requires `@NoTenant()`. Validates that caller has an active membership in an active tenant. Attaches `request.tenant = { tenantId, userId, role, permissions }`.
3. `PlatformAdminGuard`: Validates platform admin status using SQL `public.is_platform_admin()`. Required by `@RequirePlatformAdmin()`.
4. `SuperAdminGuard`: Validates super admin role using SQL `public.platform_admin_role()`. Required by `@RequireSuperAdmin()`.
5. `PermissionGuard`: Evaluates permissions via `can(actor, permission)` using canonical rules from `permissions.ts`. Required by `@RequirePermission(p)`.
6. `LiveAuthGuard`: Performs synchronous live session verification against Supabase Auth (`/auth/v1/user`, 3s timeout, fail-closed). Required by `@RequireLiveAuth()` on high-risk mutations.

## Rate limiting and trust proxy topology (D-019, AC-B-72)

In-process rate limiting is provided by `@nestjs/throttler` via `PublicRateLimitGuard` (60 req/min default) and `ReadyRateLimitGuard` (30 req/min default).

### Operational limitations
- **In-process scope:** Rate limiter storage is memory-backed per instance. Limits are enforced per API process instance, not across a distributed cluster.
- **Resets on restart:** Memory counters reset on process restart or redeployment.
- **Grows with instances:** Total allowed throughput across the cluster grows with the number of running instances.
- **Edge / CDN recommendation:** For production DDoS protection, brute-force mitigation, and multi-region rate limiting, rate limiting should be configured at the Edge/CDN layer (e.g. Cloudflare, Fastly, AWS CloudFront).
- **TRUST_PROXY default and OPEN topology:** `TRUST_PROXY` defaults to `0` (disabled), which means `X-Forwarded-For` is completely ignored and all requests arriving through a reverse proxy (such as Next.js) share one observed IP and bucket. `TRUST_PROXY` stays 0 until the deployment topology is confirmed (OPEN). When deployed behind a known proxy hop count, `TRUST_PROXY=N` can be enabled to trust the Nth proxy hop from the right without trusting arbitrary client-supplied leftmost headers.

## API contracts and pagination (D-021, D-022, AC-B-99)

- All error responses follow the standard shape `{ statusCode, error, message, path, timestamp, code, fieldErrors? }`. Error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNKNOWN`.
- Success responses return bare DTOs (200, 201, 204).
- Paginated lists return `{ items, total, page, pageSize }`.

### Deliberate pageSize difference from frontend (AC-B-99)
- `store-forge-api` accepts `pageSize` only from the strict set `[10, 20, 50, 100]` with default `20`. Invalid sizes return 400 `VALIDATION_FAILED` with `fieldErrors.pageSize`, and values are **never clamped**.
- The frontend UI uses page sizes of 12, 24, 48. Next.js callers must map frontend pagination parameters to API-supported sizes (e.g. 10 or 20) when proxying or querying the backend.

## Schema ownership and migration sync (D-004, D-018)

The backend never generates or runs migrations against Supabase and has no `drizzle-kit`.
Migrations and schema are owned exclusively by `store-forge`.
A read-only mirror and migrations snapshot are maintained in `src/infrastructure/database/` using `scripts/sync-schema.mjs`:

```bash
# Sync from frontend repository:
node scripts/sync-schema.mjs sync --source ../store-forge

# Check drift:
node scripts/sync-schema.mjs check --source ../store-forge
```

CI runs this drift check on pull requests against `wnr-group/store-forge`.

## Decision register (D-001 to D-025)

| ID | Decision | Owner / Target | Status |
|---|---|---|---|
| D-001 | Use NestJS 12 (ESM) | Eshwar / PR-A | APPROVED |
| D-002 | Foundation-first architecture | Eshwar / PR-A | APPROVED |
| D-003 | Next.js sole intended caller (boundary convention) | Architecture / PR-A | APPROVED |
| D-004 | Schema and migration ownership in frontend with drift check | Eshwar / PR-A | APPROVED |
| D-005 | Template engine sharing mechanism | Architecture | OPEN |
| D-006 | Responsibility split between API and Next.js server actions | Architecture | OPEN |
| D-007 | Frontend baseline branch alignment | Architecture | OPEN |
| D-008 | ES256 JWKS authentication and live auth check | Eshwar / PR-B | APPROVED |
| D-009 | Public endpoint abuse protection | Architecture / PR-A | OPEN |
| D-010 | Shared Supabase project (`xrkwyjnjemyxrbdbfmcn`) & `storeforge_app` role | Eshwar / PR-A, PR-B | APPROVED |
| D-011 | Drizzle ORM and `withUserContext` RLS pattern | Eshwar / PR-A | APPROVED |
| D-012 | Module ownership split | Eshwar & Santu / PR-A | APPROVED |
| D-013 | Five public storefront operations | Eshwar / PR-D | APPROVED |
| D-014 | Isolated `ProvisioningModule` with four admin auth methods | Eshwar / PR-C | APPROVED |
| D-015 | Swagger OpenAPI documentation and decorators | Eshwar / PR-B | APPROVED |
| D-016 | Env loading (`.env.local` before `.env`) and validation | Eshwar / PR-A | APPROVED |
| D-017 | PR workflow, CI verification and CODEOWNERS | Eshwar / PR-A | APPROVED |
| D-018 | CI drift check, PGlite integration tests, token secret | Eshwar / PR-A | APPROVED |
| D-019 | Public rate limiting (60/min) and `TRUST_PROXY` | Eshwar / PR-B | APPROVED |
| D-020 | Strict `X-Tenant-Id` header and permission guard | Eshwar / PR-B | APPROVED |
| D-021 | Standard error contract with `code` and `fieldErrors` | Eshwar / PR-B | APPROVED |
| D-022 | Bare DTO responses, pagination query and envelope contract | Eshwar / PR-B | APPROVED |
| D-023 | Health liveness and readiness endpoints | Eshwar / PR-A, PR-B | APPROVED |
| D-024 | Platform-admin safeguard primitives, rate limits and audit | Eshwar / PR-B | APPROVED |
| D-025 | Database test kit (PGlite) and auth test kit | Eshwar / PR-A, PR-B | APPROVED |
