# store-forge-api

Dedicated NestJS REST API for StoreForge. It migrates the backend behaviour of the existing Next.js app (server actions + services) into an independently deployable API: Supabase Auth for identity, Supabase PostgreSQL through Drizzle ORM for data, and the same Row Level Security model for tenant isolation.

> **Status: backend complete and tested; frontend not integrated.** 74 endpoints are implemented, documented in Swagger and covered by tests. The Next.js app does **not** call this API yet and was not modified. Template customization is intentionally excluded. See [docs/API_READINESS_REPORT.md](docs/API_READINESS_REPORT.md) for numbers, gaps and open decisions.

The existing Next.js app lives in a separate repository, [`wnr-group/store-forge`](https://github.com/wnr-group/store-forge). It defines the database schema (`drizzle/0000`-`0024`). A copy of those migrations lives in `src/database/migrations/` so this repo can build the database on its own (`npm run db:migrate`); keep both in step until the team decides who owns the schema. Nothing was copied from it except ported business rules and the Drizzle table definitions.

## Technology stack

| Area | Technology |
|---|---|
| Runtime | Node.js 24 (>= 22.12 required), ESM |
| Framework | NestJS 12 (`common`, `core`, `platform-express`), TypeScript 6 |
| Authentication | **Supabase Auth**; access tokens verified with `jose` against the project's JWKS |
| Database | Supabase PostgreSQL via **Drizzle ORM** + `postgres` (transaction pooler) |
| Validation | `class-validator` / `class-transformer` |
| API docs | `@nestjs/swagger` (OpenAPI + Swagger UI) |
| Security | `helmet`, CORS allowlist, `@nestjs/throttler`, RLS, per-admin DB rate limits |
| Tests | Vitest, `supertest`, PGlite (real migrations, real RLS) |
| Lint / format | `oxlint` (type-aware), Prettier |

## Prerequisites

- Node.js **>= 22.12** and npm.
- A Supabase project. Apply the schema with `DIRECT_URL=... npm run db:migrate` (owner connection; see `src/database/migrations/README.md`), or use a database that already has it.
- The restricted database role `storeforge_app` (created by the Next.js migration `0004_app_role.sql`; see that repo's README, "Create the application role").

## Installation

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
```

## Environment configuration

`.env.example` documents every variable. `.env` is git-ignored: never commit it. Variables are validated at startup ([src/config/env.validation.ts](src/config/env.validation.ts)); a bad value stops the app with an error that names the variable and the rule, never the value.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | no (`development`) | `development`, `production` or `test` |
| `PORT` | no (`4000`) | Listen port (the frontend uses 3000) |
| `API_PREFIX` | no (`api/v1`) | Global route prefix |
| `CORS_ORIGINS` | no (`http://localhost:3000`) | Comma-separated exact browser origins (the brief's `FRONTEND_URL`); `*` is rejected in production |
| `SWAGGER_ENABLED` | no | Serve Swagger UI; on outside production, off in production |
| `SUPABASE_URL` | **yes** | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | **yes** | Public anon key (used only to re-verify a password on `POST /auth/change-password`, and for Storage calls made with the caller's own token) |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | **Server only.** Used exclusively for the Auth Admin API (create/delete users, set passwords). Never for queries |
| `SUPABASE_JWKS_URL` | no | Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` |
| `SUPABASE_JWT_SECRET` | no | Only for legacy projects that still sign tokens with a shared HS256 secret |
| `DATABASE_URL` | **yes** | Transaction pooler URL as `storeforge_app.<ref>`. **The app refuses to start as `postgres`** (it bypasses RLS) |
| `AUTH_BFF_SECRET` | no (recommended) | 32+ character secret shared with the Next.js server; lets it supply the real visitor address and call the cookie routes without a browser Origin |
| `RATE_LIMIT_SECRET` | no | Keys the login rate-limit hashes (defaults to the service-role key) |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | no (`60` / `120`) | Global per-client rate limit; sensitive routes set stricter limits |

Supabase dashboard settings: **Auth > Providers > Email > "Confirm email" must be OFF** (StoreForge has no email verification; provisioned accounts are also created pre-confirmed). Public sign-ups are not used by StoreForge.

## Running locally

```bash
npm run start:dev        # watch mode, http://localhost:4000
curl http://localhost:4000/api/v1/health
# {"success":true,"message":"Service is running","data":{"status":"ok","service":"store-forge-api"}}
```

Production-style run: `npm run build && npm run start:prod`.

## Authentication in one minute

1. **Browsers** sign in through the API: `POST /auth/login` checks the credentials with Supabase Auth and sets **HttpOnly** session cookies (`/auth/logout`, `/auth/refresh`, `/auth/session` complete the flow). The Next.js app calls these server-to-server and relays the cookies. **API clients / Swagger** can instead sign in with the Supabase SDK (or `npm run auth:token`) and send `Authorization: Bearer <access_token>`.
2. Either token is verified for signature, issuer, audience, expiry and `role = authenticated`; the API issues no tokens of its own and stores no passwords. There is **no sign-up**: login only works for existing accounts.
3. Roles and permissions are **never** read from the token. They come from Postgres on every request (`memberships`, `platform_admins`).
4. Organization-scoped routes act on the organization named by the `X-Organization-Id` header, which is only a hint: it must match one of the caller's active memberships, otherwise `403 ORGANIZATION_ACCESS_DENIED`. Without the header the caller's first organization is used.

Cookie session, CSRF, rate limiting, rollout and rollback: [docs/COOKIE_SESSION_AUTH.md](docs/COOKIE_SESSION_AUTH.md). Details: [docs/AUTHENTICATION_ANALYSIS.md](docs/AUTHENTICATION_ANALYSIS.md), [docs/AUTHENTICATION_MIGRATION_PLAN.md](docs/AUTHENTICATION_MIGRATION_PLAN.md), [docs/ROLE_PERMISSION_MATRIX.md](docs/ROLE_PERMISSION_MATRIX.md).

## Testing APIs with Swagger

```powershell
npm run start:dev      # API on http://localhost:4000, Swagger at /api/docs
npm run auth:token     # asks for email + password, copies a Supabase access token to the clipboard (never printed)
```

In Swagger click **Authorize**, paste the token (do not type `Bearer`), **Authorize**, **Close**, then try `GET /api/v1/platform/me` or `GET /api/v1/auth/me`. Needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Full walkthrough, `X-Organization-Id`, Platform Admin vs Owner tokens and troubleshooting: [docs/SWAGGER_AUTHENTICATION_GUIDE.md](docs/SWAGGER_AUTHENTICATION_GUIDE.md).

## Tenant isolation (two independent layers)

1. **NestJS guards** (`JwtAuthGuard` -> `OrganizationContextGuard` -> `PermissionsGuard` -> `PlatformAdminGuard`) resolve the organization from the database and check the same permission rules as the Next.js app.
2. **PostgreSQL RLS.** Every query runs in a transaction that publishes the verified user id as JWT claims and does `SET LOCAL ROLE authenticated` ([src/database/user-context.ts](src/database/user-context.ts)). The existing policies and `SECURITY DEFINER` functions therefore apply to every API query, even if a service forgot a filter. Startup and the first transaction both fail closed if the connection could bypass RLS.

The service-role key never touches the database layer.

## API overview

Base path `/api/v1`. Swagger UI: **http://localhost:4000/api/docs**, OpenAPI JSON: `/api/docs-json`. Full inventory with permissions and business rules: [docs/API_ENDPOINT_INVENTORY.md](docs/API_ENDPOINT_INVENTORY.md).

| Area | Routes |
|---|---|
| Health / public | `GET /health`, `GET /health/ready`, `GET /public/branding`, `GET /public/storefronts/:slug` |
| Identity | `GET /auth/me`, `POST /auth/change-password`, `GET/PATCH /users/me`, `GET /organizations`, `GET /organizations/current` |
| Store | `GET/PATCH /store`, `POST /uploads/signed-urls` |
| Team (Owner) | `GET/POST /team/members`, `PATCH/DELETE /team/members/:userId`, `PATCH .../status`, `POST .../password` |
| Catalog | `/categories`, `/collections`, `/products` (+ `bulk-delete`, `bulk-status`, `:id/duplicate`), `/inventory`, `/inventory/adjustments` |
| Customers / analytics | `/customers`, `GET /analytics` |
| Platform Admin | `/platform/me`, `/platform/overview`, `/platform/organizations/...` (CRUD, status, store, members, ownership), `/platform/admins`, `/platform/settings`, `/platform/audit-logs`, `/platform/usage/...` |

Responses use one envelope. Success: `{ "success": true, "message": "...", "data": ..., "meta": { page, limit, total, totalPages } }` (`meta` only for paginated lists). Errors: `{ "success": false, "message": "...", "error": { "code": "PRODUCT_NOT_FOUND", "details": null }, "timestamp": "...", "path": "/api/v1/products/123" }`. Unknown/database errors become a generic 500; details are logged server-side only.

**Intentionally not present** (they do not exist in the original app): sign-up, email verification, invitations, order create/update/delete (orders are read-only), billing, subscriptions, integrations, and everything template-related. See [docs/EXCLUDED_FEATURES.md](docs/EXCLUDED_FEATURES.md).

## Testing and quality checks

| Command | What it does |
|---|---|
| `npm test` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e` | API integration tests (`test/**/*.e2e-spec.ts`): full HTTP stack on a **real migrated Postgres (PGlite)** with real RLS |
| `npm run coverage:routes` | Runs the e2e suite and reports which declared routes succeeded in a test |
| `npm run admin:create -- --email you@x.com [--name "Name"]` | Bootstrap the first **Platform Admin** (super admin). Needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL` and `PLATFORM_ADMIN_PASSWORD` in the environment |
| `SEED_DEMO_DATA=true npm run db:seed:demo` | One demo organization ("urban-nest-demo") with products, variants, customers, orders and a stock ledger; idempotent; refuses production. **Creates dummy logins with a public password: dev projects only** |
| `npm run auth:token` | Windows: sign in to Supabase and copy an access token to the clipboard for Swagger (see above) |
| `npm run db:migrate` / `db:state` | Apply the migrations (`DIRECT_URL`, owner role) / show database state (read-only) |
| `npm run db:verify-schema` | Compares the Drizzle definitions with the live database; read-only. Run as `DATABASE_URL=$DIRECT_URL` (the app role cannot see the columns) |
| `npm run lint` / `typecheck` / `format:check` / `build` | oxlint (type-aware) / `tsc --noEmit` / Prettier / compile |

The database-backed suites apply this repo's **real migrations** (`src/database/migrations`) to an in-memory Postgres; set `STOREFORGE_MIGRATIONS_DIR` to test another folder. If the folder is missing those suites are **skipped with a visible warning**.

Before a PR: `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build`.

## Project structure

```text
src/
  main.ts / app.setup.ts   bootstrap and configureApp() (shared with e2e tests)
  app.module.ts            root module; global guards run in a fixed order
  config/                  env validation + typed AppConfig
  database/                Drizzle schema (ported), RLS-as-user transactions, schema drift check
  common/                  AppException, error mapping, exception filter, response envelope,
                           guards, decorators, DTO primitives, permission rules
  modules/
    auth, users, organizations, store, storage (uploads, reference protection)
    team, categories, collections, products, inventory, customers, analytics
    public, health
    platform-admin/        organizations, admins, settings, audit, usage
test/                      e2e suites + support (PGlite harness, signed test tokens, fakes)
docs/                      audit, plans, schema, permission matrix, endpoint inventory, readiness report
scripts/                   verify-schema.ts, route-coverage.ts
```

## Development conventions

- **ESM project:** relative imports end in `.js`, no `__dirname`, tests use Vitest (`vi.fn()`).
- **Controllers** only translate HTTP to a service call (routing, DTOs, `@ApiEndpoint(...)` Swagger metadata). **Services** hold the rules and call `DatabaseService.withUser(userId, tx => ...)`; there is no other way to reach the database.
- **Every new route** needs: `@ApiTags`, `@ApiEndpoint({ summary, description, auth, permission, body, response, message, errors })`, a permission decorator (`@RequirePermission`, `@PlatformAccess`, or `@Public`), and a test. `test/swagger.e2e-spec.ts` fails if a route is undocumented.
- **Never** read `process.env` (use `ConfigService<AppConfig, true>`), log request bodies/headers/query strings, return internal error messages, or take a tenant id from the request without the guards.
- **Schema changes:** add the migration to both repos (same order) until D-004 is decided, update `src/database/schema`, and run `npm run db:verify-schema`.

## Known gaps and open decisions

See [docs/API_READINESS_REPORT.md](docs/API_READINESS_REPORT.md#remaining-issues). In short: login rate limiting (`rate_limit_login`) cannot live in an API that never sees logins; schema ownership (D-004) and the final split of responsibilities with the Next.js server actions (D-006) still need a team decision; no CI or deployment is configured; the tests have not been run against a real Supabase project.

New developers: [docs/development/santu-onboarding.md](docs/development/santu-onboarding.md) and [docs/architecture/overview.md](docs/architecture/overview.md).
