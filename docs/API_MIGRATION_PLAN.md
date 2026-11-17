# API Migration Plan

## Decisions (and why)

| Decision | Reason |
|---|---|
| Keep **RLS-as-user** database access (`withUser` transaction) rather than a privileged connection | The existing security model is RLS + SECURITY DEFINER functions. A privileged connection would silently bypass it (brief: "do not assume RLS will protect those queries" applies only if privileged; we aren't). NestJS guards add the explicit checks on top, so there are two independent layers. |
| Call existing SQL functions instead of porting their logic | They hold the rules (last super admin, atomic owner assignment, orphan detection, audit redaction). Re-implementing risks drift. |
| Organization chosen by `X-Organization-Id` **hint**, verified against memberships | Replaces cookie/host. Same semantics as `resolveActiveTenant`. |
| Flat resource routes for tenant data; `/platform/*` for admin | Matches brief's REST examples; tenant never appears as a trusted path param. |
| `zod` -> `class-validator` DTOs with the same bounds and normalisation | Brief mandates class-validator. Normalisers (trim/lowercase email, empty->null) via `class-transformer`. |
| Money as decimal text in, minor units out | Preserves existing contract and currency-digit rule. |
| No new tables, no schema changes, no new migrations | "Avoid unnecessary schema changes." DB is owned by the Next.js repo's drizzle migrations. |

## Order of work (dependency order)

1. Foundation: config/env validation, DB module (`withUser`, `withPublic`, RLS guard), Supabase JWT verifier + admin client, guards/decorators, response/exception layers, Swagger, health, security middleware.
2. auth + users + organizations (identity, memberships).
3. store + uploads/storage references.
4. categories -> collections -> products -> inventory.
5. customers -> analytics.
6. team.
7. platform-admin: organizations, admins, settings, audit, usage (+ rate limits).
8. public (branding, storefront).
9. Verification: swagger coverage, tenant-isolation suite, DB integration against PGlite with the real migrations.

## Test strategy

* Unit: permissions matrix, money/slug helpers, DTO validation, error mapping, JWT verifier (valid / bad signature / wrong issuer / wrong audience / expired / missing `sub`) using locally generated keys.
* Service/controller: with a fake `DatabaseService`.
* **Database + API integration** (Supertest, `test/*.e2e-spec.ts`): the full Nest app over PGlite loaded with the real `drizzle/*.sql` migrations from the Next.js repo (`STOREFORGE_MIGRATIONS_DIR`, default `../store-forge/drizzle`; the suites are skipped with a visible warning when it is missing), tokens signed with a local key through the production verifier, and only Supabase Auth Admin / Storage / password re-verification faked. RLS and every SECURITY DEFINER function run for real.
* Swagger coverage (`test/swagger.e2e-spec.ts`) and route coverage (`npm run coverage:routes`).

## Migration status

| Item | Status |
|---|---|
| Schema ownership | Still undecided (D-004); both repos hold the same 25 migrations. Applied to Supabase on 2026-11-10 after the tables were deleted |
| Migrations in this repo | A copy of `0000`-`0024` in `src/database/migrations` (applied with `npm run db:migrate`); no new migrations were written. One local deviation in `0004_app_role.sql` (see its README) |
| `drizzle-kit check/generate` here | Not configured to generate; `drizzle.config.ts` exists for `studio`/introspection only, `schemaFilter: ["public"]` |
| Drift guard | `npm run db:verify-schema` compares the Drizzle tables/columns/types/nullability with the live database and fails on mismatch; `test/schema-compat.e2e-spec.ts` runs the same check against the freshly migrated test database |

## Risks

* The audit log, rate-limit, settings and admin tables have **no grants**; only SECURITY DEFINER functions reach them, so the API cannot (and does not) query them directly.
* `storeforge_app` password/role must exist on the target database (README of the Next.js repo); the API uses the same `DATABASE_URL`.
* Login rate limiting is not available in an API that never sees logins (documented gap).
