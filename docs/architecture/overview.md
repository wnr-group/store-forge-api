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
