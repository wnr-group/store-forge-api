# Architecture overview

## Scope of this document

What exists today, how the backend is structured, decision register D-001 through D-025, schema ownership, and architectural boundaries.

## Next.js caller limitation (D-003, D-009)

> **Important architectural boundary:**
> Next.js is the intended caller; direct API access is not technically prevented; valid user tokens work from any client; user authentication, authorization and RLS are the real security boundaries; public endpoints need separate abuse protection.

## System overview and repository split

- **Frontend:** [`wnr-group/store-forge`](https://github.com/wnr-group/store-forge). Single source of truth for the database schema and migrations.
- **Backend:** `store-forge-api`. Dedicated NestJS modular-monolith providing scalable API services, security guards, database integration, and provisioning.

## Database and multi-tenant isolation (D-010, D-011, D-016)

- Single project: `xrkwyjnjemyxrbdbfmcn` only.
- Connecting role: `storeforge_app` only. No `postgres` owner URL, no `DIRECT_URL`, no service-role key for database access.
- Ported per-request pattern (`withUserContext` / `withPublicContext`):
  1. Opens transaction.
  2. Sets `request.jwt.claims` locally with verified identity (`sub` and `role = authenticated`).
  3. `SET LOCAL ROLE authenticated` so RLS policies are enforced.
  4. RLS guard asserts the role switch took effect and the connection cannot bypass RLS.
- Database access is encapsulated in `DatabaseModule` (`src/infrastructure/database`).

### Local testing and PGlite limits (D-018, D-025)

The database test kit runs tests using PGlite (`@electric-sql/pglite`) and an ephemeral socket server (`@electric-sql/pglite-socket`), applying snapshot migrations over a Supabase stub.

> **PGlite limits:**
> Tests using PGlite have limitations: no real pooler behaviour, no multi-instance rate limiting, and no genuine concurrent isolation. PGlite results do not prove hosted-Supabase compatibility. Hosted Supabase verification is tracked via Gate G-LIVE.

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

## Module ownership split (D-012)

- **Foundation & Shared Infrastructure (PR-A, PR-B, PR-C):** Eshwar
  - Database layer, `withUserContext`, `withPublicContext`
  - Authentication (JWKS ES256, LiveAuth)
  - Security, tenant guard, permission guard, rate limits
  - API contracts, pagination, error filter, Swagger
  - Admin auth `ProvisioningModule`
- **Platform & Public Storefront (PR-D, PR-E):** Eshwar
  - Public storefront 5 operations (D-013)
  - Platform admin operations (companies, settings, platform team, audit)
- **Feature Modules (to be built independently after foundation):** Santu
  - Catalog (products, categories, collections, inventory)
  - Customers and orders
  - Store settings and profile
  - Team management (consuming `ProvisioningModule` after permissions)
