# store-forge-api

Dedicated NestJS backend for the Store Forge e-commerce template engine. Provides scalable API services, business logic, authentication, database integration, and template management, independently maintained from the existing Next.js frontend.

> **Status: foundation only.** This repository currently contains the runnable NestJS skeleton (bootstrap, config, validation, error handling, security headers, Swagger, health check, tests). Authentication, database access and all business modules are **not implemented yet**. See [Current limitations](#current-limitations).

The existing Next.js app lives in a separate repository, [`wnr-group/store-forge`](https://github.com/wnr-group/store-forge), and keeps working independently. Nothing from it is copied here.

## Technology stack

Versions are the ones actually installed (`package-lock.json`).

| Area | Technology |
|---|---|
| Runtime | Node.js 24.18 (>= 22.12 required), ESM |
| Framework | NestJS 12.4 (`@nestjs/common`, `core`, `platform-express`) |
| Language | TypeScript 6.0 |
| Config | `@nestjs/config` 12.1 with `class-validator` 0.15 / `class-transformer` 0.5 |
| API docs | `@nestjs/swagger` 12.1 (OpenAPI + Swagger UI) |
| Security headers | `helmet` 8.3 |
| Tests | Vitest 4.1, `supertest` 7.3 |
| Lint / format | `oxlint` 1.93 (type-aware), Prettier 3.9 |
| Package manager | npm 11 |

## Prerequisites

- Node.js **>= 22.12** (the Next.js frontend uses 24.18.0; use the same if you can).
- npm (bundled with Node).
- Git.

## Installation

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env.local   # Windows PowerShell: Copy-Item .env.example .env.local
```

## Environment configuration

`.env.example` documents every variable. `.env.local` and `.env` are git-ignored: never commit them.
Environment files are loaded in order of precedence: `.env.local` first (for local developer overrides), then `.env`. Real `process.env` always takes precedence over both files.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `4000` | Listen port (the frontend uses 3000) |
| `API_PREFIX` | `api/v1` | Global route prefix |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated exact origins; `*` is rejected in production |
| `SWAGGER_ENABLED` | on outside production, off in production | Serve Swagger UI |
| `DATABASE_URL` | none (required unless `NODE_ENV=test`) | PostgreSQL connection URL (role `storeforge_app` only) |
| `DB_POOL_MAX` | `5` | Maximum database pool connections |
| `DB_PREPARE` | `false` | Enable prepared statements (keep false for transaction poolers) |
| `DB_CONNECT_TIMEOUT_SECONDS` | `10` | Database connection timeout in seconds |

Variables are validated at startup ([src/config/env.validation.ts](src/config/env.validation.ts)). A bad value stops the app with an error that names the variable and the rule, never the value. To add a variable, add it to `EnvironmentVariables`, to `AppConfig` / `buildConfig` in [src/config/configuration.ts](src/config/configuration.ts), and to `.env.example`.

Database access connects exclusively as `storeforge_app` to project `xrkwyjnjemyxrbdbfmcn` (see [docs/architecture/overview.md](docs/architecture/overview.md)).

## Database and schema ownership

The frontend (`wnr-group/store-forge`) is the single source of truth for migrations and schema.
The backend maintains a read-only mirror and migration snapshot:

```bash
# Sync from frontend repository:
node scripts/sync-schema.mjs sync --source ../store-forge

# Run schema drift check:
node scripts/sync-schema.mjs check --source ../store-forge
```

## Running locally

```bash
npm run start:dev        # watch mode, http://localhost:4000
```

Check it:

```bash
curl http://localhost:4000/api/v1/health
# {"status":"ok","service":"store-forge-api"}
```

Production-style run:

```bash
npm run build
npm run start:prod       # node dist/main
```

## Testing and quality checks

| Command | What it does |
|---|---|
| `npm test` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e` | E2E tests (`test/**/*.e2e-spec.ts`), boots the app with the real bootstrap pipeline |
| `npm run test:int` | PGlite database integration tests (`src/**/*.int-spec.ts`), applies snapshot migrations locally |
| `npm run test:cov` | Unit tests with coverage |
| `npm run lint` | oxlint, type-aware |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run format` / `format:check` | Prettier write / check |
| `npm run build` | Compile to `dist/` |

Run `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run build` before opening a PR.

## Swagger

With `SWAGGER_ENABLED` on (the default in development): **http://localhost:4000/api/docs** (JSON at `/api/docs-json`). Only implemented endpoints are documented; today that is the health check.

## Project structure

```text
src/
  main.ts              Starts the app (reads config, listens)
  app.setup.ts         configureApp(): prefix, validation, error filter, helmet, CORS, Swagger
                       (shared by main.ts and e2e tests so tests run the real pipeline)
  app.module.ts        Root module: ConfigModule + feature modules
  config/              Env validation and typed AppConfig
  common/              Cross-cutting code shared by modules (filters now; guards, decorators, pipes as needed)
  modules/             One folder per business capability (today: health)
  infrastructure/      Technical adapters (database, storage, ...) - see its README
test/                  E2E tests
docs/                  Architecture overview and developer guides
```

## Module development guide

Generate a module (the CLI registers it in `AppModule` and uses the `.js` import suffix this ESM project requires):

```bash
npx nest generate module modules/products
npx nest generate controller modules/products
npx nest generate service modules/products
npm run format           # the generator's output is not Prettier-formatted
```

Then add DTOs in `modules/products/dto/`, Swagger decorators on the controller, and unit tests next to the code. [`src/modules/health`](src/modules/health) is the reference example.

## Development conventions

- **ESM project:** relative imports end in `.js` (`import { X } from './x.js'`), there is no `__dirname` (use `import.meta.dirname`), and tests use Vitest (`vi.fn()`, not `jest.fn()`).
- **Module boundaries:** a module owns one business capability. Import another module only through its `exports`; never reach into another module's files or tables.
- **Controllers** only translate HTTP to a service call: routing, DTOs, Swagger decorators. No business logic, no database access.
- **Services** hold business rules and are the unit of dependency injection. Inject dependencies through constructors.
- **DTOs** are classes with `class-validator` decorators. The global `ValidationPipe` strips unknown properties, rejects requests that contain them (`forbidNonWhitelisted`) and transforms payloads to DTO instances.
- **Errors:** throw Nest `HttpException`s (`NotFoundException`, ...). The global filter returns `{ statusCode, error, message, path, timestamp }`; unknown errors become a generic 500 and are logged server-side only.
- **Configuration:** read it through `ConfigService<AppConfig, true>`, never `process.env` directly.
- **Tests:** unit-test services and pure functions in `*.spec.ts` next to the code; cover HTTP behaviour in `test/*.e2e-spec.ts`.
- **Security:** never log request bodies, headers or query strings, and never return internal error messages.

## Current limitations

Not implemented yet (none of this is hidden or stubbed):

- **Authentication and authorization.** There are no guards. Only the public health endpoint exists. Authentication, tenant resolution and per-module authorization must be built and tested **before any protected business endpoint is added**.
- **Database access.** No driver, ORM or connection. The health check is application-level only and does not check any dependency.
- **Business modules** (catalog, team, platform admin, templates, ...).
- **Frontend integration.** The Next.js app does not call this API yet.
- **Deployment, CI, rate limiting, observability beyond JSON logs in production.**

Open architecture decisions are listed in [docs/architecture/overview.md](docs/architecture/overview.md). New developers: start with [docs/development/santu-onboarding.md](docs/development/santu-onboarding.md).
