# Santu onboarding

Welcome! This document outlines the backend architecture, module ownership, and development practices so you can build your modules independently.

## 1. What this repository is

The dedicated NestJS backend for Store Forge (`ecom_template`). It is separate from the Next.js frontend (`wnr-group/store-forge`), which maintains the canonical database schema and migrations.

## 2. Local setup and running

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env.local    # Windows PowerShell: Copy-Item .env.example .env.local
npm run start:dev             # http://localhost:4000
curl http://localhost:4000/api/v1/health
```

Swagger documentation: http://localhost:4000/api/docs.

## 3. Architecture and module ownership split (D-012)

- **Foundation & Shared Infrastructure (PR-A, PR-B, PR-C) — Eshwar:**
  - Database service (`DatabaseService.withUser`, `withPublic`)
  - Authentication (JWKS token verification, `@CurrentUser()`)
  - Tenant context (`X-Tenant-Id`, `@RequirePermission()`)
  - Common errors, pagination DTOs, Swagger decorators
  - Provisioning service (`ProvisioningModule` for admin auth)
- **Feature Modules (after foundation PRs merge) — Santu:**
  - Catalog (products, categories, collections, inventory)
  - Customers and orders
  - Store settings and profile
  - Team management

## 4. Database integration rules (D-010, D-011)

- Single project: `xrkwyjnjemyxrbdbfmcn` only.
- Database role: `storeforge_app` only.
- Never write raw queries with superuser privileges.
- Always use `DatabaseService.withUser(userId, async (tx) => { ... })` for authenticated queries.
- Tenant isolation is enforced by Row Level Security in Postgres.

## 5. Local database test kit (D-025)

You can run database integration tests locally without any hosted database credentials!
The test kit uses PGlite with an ephemeral socket server and snapshot migrations.

```bash
# Run unit tests:
npm test

# Run database integration tests:
npm run test:int
```

> **Note on PGlite limits (D-025, D-018):**
> PGlite has limitations: no real pooler behaviour, no multi-instance rate limiting, and no genuine concurrent isolation. PGlite results do not prove hosted-Supabase compatibility.

## 6. Developing a new module

```bash
npx nest generate module modules/<name>
npx nest generate controller modules/<name>
npx nest generate service modules/<name>
npm run format
```

Use `src/modules/health` as the structural pattern. Write tests alongside your code (`*.spec.ts` for unit, `*.int-spec.ts` for database integration).

## 7. Quality verification commands

Before opening a PR, ensure all checks pass:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:e2e
npm run test:int
npm run build
```
