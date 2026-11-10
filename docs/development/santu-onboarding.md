# Santu onboarding

Welcome. This is everything you need to start; you should not need a walkthrough.

## 1. What this repository is

The dedicated NestJS backend for Store Forge (`ecom_template`). It is separate from the Next.js frontend (`wnr-group/store-forge`), which keeps running on its own. Today it is a foundation only: no auth, no database, no business modules.

## 2. Local setup and running

```bash
git clone https://github.com/wnr-group/store-forge-api.git
cd store-forge-api
npm install
cp .env.example .env
npm run start:dev          # http://localhost:4000
curl http://localhost:4000/api/v1/health
```

Swagger: http://localhost:4000/api/docs. Environment variables: see the table in the [README](../../README.md#environment-configuration). Never commit `.env` or copy credentials from the frontend repo.

Access to the GitHub repo comes through collaborator/team permissions on your own GitHub account; do not share credentials.

## 3. Creating a module

```bash
npx nest generate module modules/<name>
npx nest generate controller modules/<name>
npx nest generate service modules/<name>
npm run format
```

The CLI registers the module in `AppModule`. Use [`src/modules/health`](../../src/modules/health) as the pattern: controller (HTTP only) -> service (logic) -> DTOs with `class-validator` -> Swagger decorators -> unit tests beside the code.

## 4. Conventions

- Relative imports end in `.js` (ESM). Tests use Vitest (`vi.fn()`).
- One module = one business capability. Other modules may use yours only through its `exports`.
- No business logic in controllers. No `process.env`; use `ConfigService<AppConfig, true>`.
- Throw Nest `HttpException`s; the global filter formats the response.
- Never log request bodies, headers or query strings.
- Keep files small and PRs focused. Run the full check (below) before a PR.

## 5. Testing commands

```bash
npm test                 # unit
npm run test:e2e         # e2e (real bootstrap pipeline)
npm run lint
npm run typecheck
npm run format:check
npm run build
```

## 6. Current architecture

Modular monolith, see [architecture/overview.md](../architecture/overview.md). Implemented: bootstrap, validation, error shape, helmet, CORS, config validation, Swagger, health.

## 7. Frontend integration status

None. The Next.js app does not call this API. Today it runs its own logic as server actions against Supabase Postgres with Row Level Security; how that responsibility is split with this API is an **open decision** (D-006).

## 8. Known limitations

No authentication, authorization, tenant resolution, database access, rate limiting or CI. The health check does not verify any dependency. **Do not add a protected business endpoint until authentication, tenant resolution and authorization exist.** Do not add a database connection until the integration approach (overview, "Database integration") is agreed: the existing Supabase Row Level Security must not be bypassed.

## 9. Recommended next steps

1. Review this foundation with Eshwar and agree the open decisions D-003 to D-007 in the architecture overview.
2. Agree the module split (below) and record it in the tracker.
3. Build the shared pieces first (database context + auth guard + tenant resolution), with security tests, before feature modules depend on them.
4. Then implement your agreed modules one at a time, each with unit and e2e tests.

## 10. Module ownership (preliminary template)

**Not agreed.** Owners are intentionally blank. Candidate modules come from the frontend's `services/` directory and still need review for dependencies and boundaries before anyone is assigned.

| Module | Eshwar | Santu | Status |
|---|---|---|---|
| Backend foundation | Primary | Review | Done, in review |
| Auth, tenant context and database access (shared prerequisite) | TBD | TBD | Pending allocation |
| Catalog (products, categories, collections, inventory) | TBD | TBD | Pending allocation |
| Customers and analytics | TBD | TBD | Pending allocation |
| Store settings, team, profile | TBD | TBD | Pending allocation |
| Platform admin (companies, usage, audit, settings) | TBD | TBD | Pending allocation |
| Templates and storefront | TBD | TBD | Pending allocation |
| Frontend integration | Shared | Shared | Pending |
| Testing | Shared | Shared | Pending |
