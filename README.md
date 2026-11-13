# store-forge-api

The NestJS REST API behind StoreForge. It owns the business logic, permissions and tenant isolation, and is the only service that talks to the database. Identity comes from Supabase Auth and data is stored in Supabase PostgreSQL through Drizzle ORM.

The Next.js frontend lives in [`wnr-group/store-forge`](https://github.com/wnr-group/store-forge) and calls this API from its server.

Swagger UI is at http://localhost:4000/api/docs when the API is running.

## Tech stack

| Area | Technology |
|---|---|
| Runtime | Node.js 22.12 or newer, ESM |
| Framework | NestJS 12, TypeScript |
| Auth | Supabase Auth; tokens verified with `jose` against the project's JWKS |
| Database | Supabase PostgreSQL, Drizzle ORM, `postgres` driver (transaction pooler) |
| Validation | `class-validator`, `class-transformer` |
| API docs | `@nestjs/swagger` |
| Security | `helmet`, CORS allowlist, `@nestjs/throttler`, Row Level Security |
| Tests | Vitest, `supertest`, PGlite (real migrations, real RLS) |
| Lint / format | `oxlint`, Prettier |

## Getting started

**You need:** Node.js 22.12 or newer, npm, and a Supabase project.

1. Install:

   ```bash
   git clone https://github.com/wnr-group/store-forge-api.git
   cd store-forge-api
   npm install
   cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
   ```

2. Fill in `.env` (see [Environment variables](#environment-variables)). Never commit it.

3. In Supabase, go to **Auth > Providers > Email** and turn **"Confirm email" off**. StoreForge has no email verification, and provisioned accounts are created already confirmed.

4. Create the database schema. The `storeforge_app` role is created by migration `0004_app_role.sql`:

   ```bash
   npm run db:migrate
   ```

5. Create the first Platform Admin:

   ```bash
   npm run admin:create -- --email you@example.com --name "Your Name"
   ```

   This needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL` and `PLATFORM_ADMIN_PASSWORD` in the environment.

6. Start the API and check it:

   ```bash
   npm run start:dev
   curl http://localhost:4000/api/v1/health
   ```

For a production-style run use `npm run build && npm run start:prod`.

Optional, development projects only: `SEED_DEMO_DATA=true npm run db:seed:demo` adds a demo organization with sample data. It creates dummy logins with a public password and refuses to run in production.

## Environment variables

Environment files are loaded in order: `.env.local` first (preferred for local overrides), then `.env`. Neither is committed.

`.env.example` lists every variable. They are validated at startup ([src/config/env.validation.ts](src/config/env.validation.ts)); a bad value stops the app with an error that names the variable but never shows its value.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | no (`development`) | `development`, `production` or `test` |
| `PORT` | no (`4000`) | Port to listen on |
| `API_PREFIX` | no (`api/v1`) | Route prefix |
| `CORS_ORIGINS` | no (`http://localhost:3000`) | Comma-separated browser origins allowed to call the API. `*` is rejected in production |
| `SWAGGER_ENABLED` | no | Serve Swagger UI. On by default, off in production |
| `SUPABASE_URL` | **yes** | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | **yes** | Public anon key. Used to re-check a password on change, and for Storage calls made with the caller's own token |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Server only. Used only for the Auth Admin API (create and delete users, set passwords), never for queries |
| `DATABASE_URL` | **yes** | Transaction pooler URL for the `storeforge_app` role. The app refuses to start as `postgres`, because that role bypasses RLS |
| `DIRECT_URL` | for scripts | Owner connection, used only by `db:migrate`, `admin:create` and `db:verify-schema` |
| `AUTH_BFF_SECRET` | recommended | 32+ characters, the same value as in the Next.js app. Lets the frontend server pass the real visitor address and call the cookie routes without a browser Origin |
| `SUPABASE_JWKS_URL` | no | Defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` |
| `SUPABASE_JWT_SECRET` | no | Only for legacy projects that sign tokens with a shared HS256 secret |
| `RATE_LIMIT_SECRET` | no | Keys the login rate-limit hashes. Defaults to the service-role key |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | no (`60` / `120`) | Global per-client rate limit. Sensitive routes use stricter limits |

## How authentication works

1. **Browsers** sign in through the API: `POST /auth/login` checks the credentials with Supabase Auth and sets HttpOnly session cookies. `/auth/logout`, `/auth/refresh` and `/auth/session` complete the flow. The Next.js server makes these calls and relays the cookies.
2. **API clients and Swagger** can instead send `Authorization: Bearer <access_token>` with a Supabase access token.
3. Tokens are checked for signature, issuer, audience, expiry and `role = authenticated`. The API issues no tokens and stores no passwords. There is no sign-up: only existing accounts can sign in.
4. Roles are never read from the token. They are loaded from Postgres (`memberships`, `platform_admins`) on every request.
5. Organization routes use the organization named in the `X-Organization-Id` header. It must match one of the caller's active memberships, or the API returns `403 ORGANIZATION_ACCESS_DENIED`. Without the header, the caller's first organization is used.

More detail: [Cookie session auth](docs/COOKIE_SESSION_AUTH.md), [Authentication analysis](docs/AUTHENTICATION_ANALYSIS.md), [Role and permission matrix](docs/ROLE_PERMISSION_MATRIX.md).

## Trying the API in Swagger

```powershell
npm run start:dev      # Swagger at http://localhost:4000/api/docs
npm run auth:token     # asks for email and password, copies an access token to the clipboard
```

In Swagger click **Authorize**, paste the token (without typing `Bearer`), then try `GET /api/v1/auth/me`. Full walkthrough: [Swagger authentication guide](docs/SWAGGER_AUTHENTICATION_GUIDE.md).

## Tenant isolation

Two independent layers protect each company's data:

1. **NestJS guards** (`JwtAuthGuard`, `OrganizationContextGuard`, `PermissionsGuard`, `PlatformAdminGuard`) resolve the organization from the database and check permissions.
2. **PostgreSQL Row Level Security.** Every query runs in a transaction that sets the verified user id and switches to the `authenticated` role ([src/database/user-context.ts](src/database/user-context.ts)). The RLS policies therefore apply to every query, even if a service forgets a filter. The app fails closed if the connection could bypass RLS.

The service-role key never touches the database layer.

## API overview

Base path `/api/v1`. The OpenAPI JSON is at `/api/docs-json`. Every endpoint with its permissions and rules is listed in [docs/API_ENDPOINT_INVENTORY.md](docs/API_ENDPOINT_INVENTORY.md).

| Area | Routes |
|---|---|
| Health and public | `GET /health`, `GET /health/ready`, `GET /public/branding`, `GET /public/storefronts/:slug` |
| Identity | `/auth/*`, `GET/PATCH /users/me`, `GET /organizations`, `GET /organizations/current` |
| Store | `GET/PATCH /store`, `POST /uploads/signed-urls` |
| Team (Owner) | `/team/members` (list, add, edit, remove, status, password reset) |
| Catalog | `/categories`, `/collections`, `/products`, `/inventory`, `/inventory/adjustments` |
| Theme Store and design | `GET /themes`, `GET /themes/:slug`, `GET/POST /store/theme`, `POST /store/theme/publish`, `/store/templates/*` (list, open, preview, save draft, publish, history, restore) |
| Customers and analytics | `/customers`, `GET /analytics` |
| Platform Admin | `/platform/*`: organizations, admins, settings, audit logs, usage |

Every response uses one envelope.

```jsonc
// success (meta only on paginated lists)
{ "success": true, "message": "...", "data": {}, "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } }

// error
{ "success": false, "message": "...", "error": { "code": "PRODUCT_NOT_FOUND", "details": null }, "timestamp": "...", "path": "/api/v1/products/123" }
```

Unknown and database errors become a generic 500. Details are logged on the server only.

**Not included on purpose:** sign-up, email verification, invitations, creating or editing orders (orders are read-only), billing, subscriptions, integrations and template customization. See [docs/EXCLUDED_FEATURES.md](docs/EXCLUDED_FEATURES.md).

## Commands

| Command | Purpose |
|---|---|
| `npm run start:dev` | Start in watch mode |
| `npm run build` / `npm run start:prod` | Compile / run the build |
| `npm test` | Unit tests |
| `npm run test:e2e` | Integration tests: full HTTP stack on an in-memory Postgres (PGlite) with the real migrations and RLS |
| `npm run test:all` | Unit and e2e tests |
| `npm run coverage:routes` | Run the e2e suite and report which routes a test exercised |
| `npm run lint` / `typecheck` / `format:check` | oxlint / TypeScript / Prettier |
| `npm run db:migrate` | Apply migrations (uses `DIRECT_URL`) |
| `npm run db:state` | Show database state (read-only) |
| `npm run db:verify-schema` | Compare the Drizzle schema with the live database (read-only). Run with `DATABASE_URL=$DIRECT_URL` |
| `npm run admin:create` | Create the first Platform Admin |
| `npm run db:seed:demo` | Add demo data (development only) |
| `npm run auth:token` | Windows: copy a Supabase access token to the clipboard for Swagger |

The e2e suites apply the migrations in `src/database/migrations`. Set `STOREFORGE_MIGRATIONS_DIR` to test another folder. If the folder is missing, those suites are skipped with a visible warning.

Before opening a PR: `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build`.

## Project structure

```text
src/
  main.ts, app.setup.ts   Startup and shared app configuration
  app.module.ts           Root module; global guards run in a fixed order
  config/                 Environment validation and typed config
  database/               Drizzle schema, migrations, RLS transactions, schema drift check
  common/                 Errors, exception filter, response envelope, guards, decorators, permission rules
  modules/                One folder per feature:
                          auth, users, organizations, store, storage, team, categories,
                          collections, products, inventory, customers, analytics, public,
                          health, platform-admin
test/                     E2E suites and test support (PGlite harness, signed test tokens)
scripts/                  Migration, admin creation, seeding, schema check, route coverage
docs/                     Design notes, schema, permission matrix, endpoint inventory
```

## Development rules

- **ESM:** relative imports end in `.js`. Tests use Vitest (`vi.fn()`).
- **Controllers** only turn HTTP into a service call. **Services** hold the rules and reach the database only through `DatabaseService.withUser(userId, tx => ...)`.
- **Every new route** needs `@ApiTags`, `@ApiEndpoint({...})` Swagger metadata, a permission decorator (`@RequirePermission`, `@PlatformAccess` or `@Public`) and a test. `test/swagger.e2e-spec.ts` fails if a route is undocumented.
- **Never** read `process.env` (use `ConfigService<AppConfig, true>`), log request bodies, headers or query strings, return internal error messages, or take a tenant id from the request without the guards.
- **Schema changes:** add a migration in `src/database/migrations`, update `src/database/schema`, and run `npm run db:verify-schema`.

## Known gaps

See [docs/API_READINESS_REPORT.md](docs/API_READINESS_REPORT.md). In short: who owns the database schema and the final split of work with the Next.js server actions still need a team decision, no CI or deployment is set up, and the tests have not been run against a real Supabase project.

New developers: start with [docs/development/santu-onboarding.md](docs/development/santu-onboarding.md) and [docs/architecture/overview.md](docs/architecture/overview.md).
