# Architecture overview

## Scope of this document

What exists today, how the backend is meant to fit around the existing Next.js app, and which decisions are still open. Items marked **Proposal** are recommendations, not approved decisions.

## What exists today (implemented)

> **Update (branch `feature/nestjs-api-migration`):** the foundation below is now followed by the complete backend: Supabase JWT verification, RLS-as-user database access, tenant resolution, permissions and 74 endpoints. See [API_READINESS_REPORT.md](../API_READINESS_REPORT.md). The list that follows describes the original foundation and is kept for context.

A modular-monolith NestJS 12 application with:

- Global prefix (`/api/v1`), global `ValidationPipe` (whitelist, reject unknown fields, transform).
- One error shape for all failures; unknown errors are not leaked to clients.
- `helmet` security headers, environment-driven CORS allowlist.
- Validated, typed configuration (fails fast at startup, never prints values).
- Swagger at `/api/docs`, JSON logs in production.
- One feature module: `health` (application-level liveness only).

Request flow: `main.ts` -> `configureApp()` (prefix, helmet, CORS, pipe, filter, Swagger) -> controller -> service.

Why a modular monolith: one deployable, one repository, clear module boundaries. There is no evidence (load, team size, independent scaling needs) that justifies microservices.

## The existing system (evidence from `wnr-group/store-forge`)

Observed in the frontend repository (branch `feat/template-engine-pr-readiness`):

- Next.js 16 / React 19 / TypeScript; no REST API at all: backend logic runs as server actions calling `services/*.ts`.
- **Supabase Postgres** accessed with Drizzle ORM + postgres-js, through the Supabase transaction pooler.
- **Supabase Auth** (cookie sessions via `@supabase/ssr`); the service-role key is used only for the Admin Auth API (provisioning users).
- **Supabase Storage**: browser uploads straight to signed URLs; the server verifies and cleans up.
- **Multi-tenant isolation by Postgres Row Level Security.** The app connects as the limited role `storeforge_app`; each request opens a transaction, sets the verified user's JWT claims and runs `SET LOCAL ROLE authenticated`, so RLS policies apply. App-level permission checks deliberately duplicate RLS.
- 25 SQL migrations (`drizzle/0000`-`0024`) with many `SECURITY DEFINER` functions (platform admin, public storefront, rate limits).
- Checkout, orders and payments are not built; there are no webhooks, queues or other external integrations.

## Database integration (Proposal, not implemented)

- **Reuse the existing Supabase Postgres** as the single source of truth. Do not introduce a second database or a competing schema.
- Connect as `storeforge_app` (never `postgres` or the service-role key) and **port the same per-request pattern**: transaction -> set claims from a *verified* identity -> `SET LOCAL ROLE authenticated` -> run queries, with the same guard that refuses to run if the role can bypass RLS. A pooled "superuser" ORM connection would silently bypass tenant isolation.
- Prefer **Drizzle** (already used by the frontend, first-party Nest support via `@nestjs/drizzle`) over Prisma/TypeORM, which would duplicate the schema and fight the per-request role switch.
- Keep it behind a Nest module in `src/infrastructure/` so feature modules never see connection details.
- The service-role key, if ever needed, goes in one isolated provisioning module with its own security design.

## Authentication (Proposal, not implemented)

The frontend uses cookies; a separate API will most likely take a Supabase access token in `Authorization: Bearer`, verified on the server (never trusting a decoded-but-unverified token). Identity must come only from that verified token; tenant ids from URLs, headers or bodies are preferences to be checked against database memberships, as the frontend does today. Cross-origin cookies and the per-store subdomain model (`<store>.<root>`) need a deliberate design.

## Open decisions

| ID | Decision | Status |
|---|---|---|
| D-001 | Use NestJS | Approved (Eshwar's project decision; Sibi said "preferably") |
| D-002 | Scope of "everything is set" | Foundation only, per Sibi: "Just basic setup is enough" |
| D-003 | Auth transport (bearer token vs cookie/BFF) and token verification method | **Implemented as bearer token verified against Supabase JWKS** (per the migration brief); needs team confirmation |
| D-004 | Who owns the schema and migrations (today in `store-forge`, with the PGlite RLS test suite) | **Open.** Implemented on the assumption that `store-forge` keeps owning them; this repo creates none and its tests apply that repo's migrations |
| D-005 | How the template engine (`lib/templates`, shared by renderer and validator) is shared or split | Open |
| D-006 | Which responsibilities move to this API vs stay in Next.js server actions | **Open.** The API implements every server-action capability except template customization; the Next.js app is unchanged and does not call it |
| D-007 | Frontend baseline branch (`main` vs the template-engine branch) | Open |

## Security baseline and what it does not cover

Done: CORS allowlist, helmet, request validation, safe error responses, no secrets in the repo, fail-fast config.

Not done, and required before exposing protected endpoints: authentication, tenant resolution, per-module authorization, rate limiting, audit logging. Existing RLS policies and tenant isolation in the database are untouched by this repository.

## Merge note: schema ownership is unresolved

The `main` branch documents the frontend repository (`wnr-group/store-forge`) as the only owner of migrations, with a read-only schema mirror in `src/infrastructure/database/` kept by `scripts/sync-schema.mjs` and no `drizzle-kit` in this repo (D-004, D-018). This branch instead owns its schema and migrations in `src/database/` and generates them with `drizzle-kit`. Both layers currently exist side by side; only `src/database` is wired into `AppModule`. Which one wins is an open team decision.

## Next.js caller limitation (D-003, D-009)

> **Important architectural boundary:**
> Next.js is the intended caller; direct API access is not technically prevented; valid user tokens work from any client; user authentication, authorization and RLS are the real security boundaries; public endpoints need separate abuse protection.

### Local testing and PGlite limits (D-018, D-025)

The database test kit runs tests using PGlite (`@electric-sql/pglite`) and an ephemeral socket server (`@electric-sql/pglite-socket`), applying snapshot migrations over a Supabase stub.

> **PGlite limits:**
> Tests using PGlite have limitations: no real pooler behaviour, no multi-instance rate limiting, and no genuine concurrent isolation. PGlite results do not prove hosted-Supabase compatibility. Hosted Supabase verification is tracked via Gate G-LIVE.

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
