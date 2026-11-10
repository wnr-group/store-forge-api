# Authentication Migration Plan

## Principles (from the brief, confirmed against the audit)

* Supabase Auth is the only identity provider. NestJS issues no tokens, stores no passwords, mirrors no `auth.*` tables.
* No email verification, no signup, no invitation, no forgot-password flow. None exist today.
* Existing behaviour is preserved: provisioned, pre-confirmed accounts; direct SDK sign-in.

## Responsibility split

| Operation | Today | After migration |
|---|---|---|
| Sign in (`signInWithPassword`) | Next server action | **Supabase SDK, client-side.** Documented, not duplicated in NestJS. |
| Sign out | Next server action | **Supabase SDK.** |
| Token refresh | `@supabase/ssr` + proxy `getClaims()` | **Supabase SDK** (`autoRefreshToken`). API returns 401 `TOKEN_EXPIRED` so a client can refresh and retry. |
| Verify identity | `getUser()` per request | **`JwtAuthGuard`**: verify the access token with Supabase JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, `jose`), check signature, `iss = {SUPABASE_URL}/auth/v1`, `aud = authenticated`, `exp`, `sub` is a UUID, `role = authenticated`. |
| Change own password | Next action | `POST /auth/change-password` -> Supabase (`signInWithPassword` to re-verify, then `PUT /auth/v1/user` with the caller's bearer token). |
| Provision users (owner, member, platform admin) | `auth.admin.createUser` | Same, in `SupabaseAdminService` (service-role, server-only, Auth Admin API only). Compensating delete retained. |
| Admin-assisted password reset | `auth.admin.updateUserById` | Same. |
| Login rate limiting | DB `rate_limit_login` before login | Not reproducible: the API does not see logins. Supabase's own limits apply. Recorded in the readiness report as a gap for the frontend integration phase. |

## Guard pipeline (global, in order)

1. `ThrottlerGuard` - generic rate limit.
2. `JwtAuthGuard` - skipped for `@Public()`. Sets `request.user = { id, email, token }` from verified claims only.
3. `OrganizationContextGuard` - for routes marked `@TenantScoped()`: loads memberships for `request.user.id` from Postgres, picks the organization (`X-Organization-Id` header is a **hint**; unknown / foreign id -> 403 `ORGANIZATION_ACCESS_DENIED`, absent -> first membership, none -> 404 `NO_WORKSPACE`), attaches `{ organizationId, role, permissions }`.
4. `PermissionsGuard` - `@RequirePermission('catalog:manage')` evaluated by the same `can()` rules as `lib/auth/permissions.ts`.
5. `PlatformAdminGuard` - `@PlatformAdmin()` / `@SuperAdmin()` asks `public.is_platform_admin()` / `platform_admin_role()`.

## Database identity (tenant isolation, second layer)

Every query runs in `DatabaseService.withUser(userId, fn)`: a transaction that sets `request.jwt.claims` / `request.jwt.claim.sub` and `SET LOCAL ROLE authenticated`, exactly like `lib/db/user-context.ts`. RLS therefore applies to every API query even though the app connects with a pooled login role. Startup refuses a `postgres` / `postgres.<ref>` user, and the first transaction asserts `current_user = authenticated` and that neither role has `rolsuper`/`rolbypassrls`.

The service-role key is used only by `SupabaseAdminService` for Auth Admin calls. It never touches the database layer.

## Supabase project settings required

* Auth -> Providers -> Email: **Confirm email = OFF** (accounts are also created with `email_confirm: true`).
* Public signups disabled (current app has no signup UI; recommended hardening, not changed by this repo).
* JWT signing: asymmetric keys (JWKS) preferred. For legacy HS256 projects set `SUPABASE_JWT_SECRET`; the verifier falls back to it only when no JWKS is reachable and the token header says `HS256`.
