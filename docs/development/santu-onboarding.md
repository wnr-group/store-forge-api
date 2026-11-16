# Santu onboarding

Welcome! This document outlines the backend architecture, module ownership, security decorators, and development practices so you can build your modules independently.

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
curl http://localhost:4000/api/v1/health/ready
```

Swagger documentation: http://localhost:4000/api/docs.

## 3. Architecture and module ownership split (D-012)

- **Foundation & Shared Infrastructure (PR-A, PR-B, PR-C) — Eshwar:**
  - Database service (`DatabaseService.withUser`, `withTenant`, `withPublic`)
  - Authentication (JWKS token verification, `@CurrentUser()`, `@RequireLiveAuth()`)
  - Tenant context (`X-Tenant-Id`, `@RequirePermission()`, `@TenantContext()`)
  - Common errors (`AppException`), pagination DTOs, Swagger decorators
  - Provisioning service (`ProvisioningModule` for admin auth)
- **Feature Modules (built independently on top of foundation) — Santu:**
  - Catalog (products, categories, collections, inventory)
  - Customers and orders
  - Store settings and profile
  - Team management

## 4. Security decorators and guard pipeline (D-008, D-020, D-024)

Every request passes through 6 global guards in a fixed order. You declare route behaviour using decorators:

| Decorator | Effect |
|---|---|
| `@Public()` | Skips auth entirely (public routes). |
| *No decorator* | **Tenant-scoped by default!** Requires `Authorization: Bearer <jwt>` AND `X-Tenant-Id: <uuid>`. Resolves active membership in an active tenant. |
| `@NoTenant()` | Requires authenticated user token, but skips `X-Tenant-Id` requirement (e.g. user profile, platform admin). |
| `@RequirePermission('module:action')` | Checks whether the actor has permission to perform the action via `can(actor, permission)`. |
| `@RequirePlatformAdmin()` | Requires user to be a verified platform admin. |
| `@RequireSuperAdmin()` | Requires user to be a verified super admin. |
| `@RequireLiveAuth()` | Requires synchronous Supabase live session re-verification for high-risk operations (fail-closed, 3s timeout). |

### Param decorators
- `@CurrentUser()`: Injects `{ id: string }` from verified JWT.
- `@TenantContext()`: Injects `{ tenantId, userId, role, permissions }`.

## 5. Database operations and multi-tenant isolation

- **Connecting role:** `storeforge_app` only.
- **Tenant isolation:** Always execute tenant-scoped queries inside `withTenant`:
  ```ts
  await this.databaseService.withTenant(
    { tenantId, userId },
    async (tx, tenantCtx) => {
      // tx has SET LOCAL ROLE authenticated and request.jwt.claims set.
      // Active membership was re-verified inside the transaction.
      // Drizzle queries against tenant tables will enforce RLS.
    },
  );
  ```
- **Platform/User operations:** Use `this.databaseService.withUser(userId, async (tx) => { ... })`.

## 6. Swagger documentation decorators (D-015)

Document your controller endpoints using the shared decorators:
- Public endpoints: `@ApiPublic()`.
- Authenticated non-tenant endpoints: `@ApiAuth()`.
- Tenant endpoints: `@ApiTenantAuth('module:action'?)`.
- Standard errors: `@ApiStandardErrors()`.
- Paginated endpoints: `@ApiPagedResponse(MyItemDto)`.

## 7. API contracts and errors (D-021, D-022)

### Error responses
Throw `AppException` or use standard helpers:
```ts
throw new AppException(HttpStatus.NOT_FOUND, {
  code: ErrorCode.NOT_FOUND,
  message: 'Product not found',
});
```

### Next.js header forwarding (AC-B-98)
Next.js server callers must forward the user's Supabase JWT in `Authorization: Bearer <token>` and the selected tenant ID in `X-Tenant-Id: <uuid>`.

### Page size contract (AC-B-99)
- `store-forge-api` strictly accepts `pageSize` from `[10, 20, 50, 100]` with default `20`. Invalid sizes return 400 `VALIDATION_FAILED` and are never clamped.
- The frontend UI uses 12/24/48. Ensure your frontend actions map their pagination requests to supported API sizes.

## 8. Local database test kit (D-025)

Run database integration tests locally without hosted credentials using PGlite:

```bash
# Run unit tests:
npm test

# Run database integration tests:
npm run test:int
```

> **Note on PGlite limits (D-025, D-018):**
> PGlite has limitations: no real pooler behaviour, no multi-instance rate limiting, and no genuine concurrent isolation. PGlite results do not prove hosted-Supabase compatibility.

## 9. Quality verification commands

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
