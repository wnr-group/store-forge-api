# Authentication Analysis (existing Next.js app)

Everything below was read from source, not assumed.

| Question | Answer | Evidence |
|---|---|---|
| Provider | Supabase Auth only | `lib/supabase/*` |
| Registration | **None.** No sign-up action or page. Users are provisioned with the Admin Auth API: `auth.admin.createUser({ email_confirm: true, user_metadata.full_name, app_metadata.provisioned })`. A DB trigger (`on_auth_user_created`) creates the `profiles` row. | `lib/auth/provisioning.ts`, `(auth)/actions.ts` comment |
| Email verification | None. Accounts are created already confirmed; `email_not_confirmed` is mapped to "contact your administrator". | `auth.service.signIn` |
| Login | `supabase.auth.signInWithPassword` in a server action, on the cookie-backed `@supabase/ssr` client. Before the password check, `enforceLoginRateLimit` (DB counters, keyed HMAC of IP+email). | `auth.service.ts`, `rate-limit.ts` |
| Logout | `supabase.auth.signOut()` (revokes server-side, clears cookies). | `auth.service.signOut` |
| Access / refresh tokens | Held in `sb-*` cookies by `@supabase/ssr`. `proxy.ts` calls `supabase.auth.getClaims()` on every request, which verifies the JWT signature and refreshes an expired session. | `lib/supabase/middleware.ts` |
| Identifying the user | `supabase.auth.getUser()` (round-trip to the Auth server, not the unverified cookie), memoised per request. | `lib/auth/session.ts` |
| User -> profile | `public.profiles.id` = `auth.users.id` (FK, cascade). | `schema/profiles.ts` |
| User -> organization | `public.memberships (tenant_id, user_id, role, status, permissions)`; unique `(tenant_id,user_id)`. | `schema/memberships.ts` |
| Role retrieval | One query: memberships joined to tenants for the validated user (`listMembershipsInTx`). RLS independently limits rows. | `tenant.service.ts` |
| Active organization | Untrusted hint (cookie `sf_active_tenant` or store subdomain) that only **selects among** the user's DB-verified memberships; unknown id -> first membership (`resolveActiveTenant`). Host-based mode requires membership in that store's tenant. | `tenant/context.ts`, `tenant/resolve.ts` |
| Roles | `owner`, `admin`, `staff` stored in `memberships.role`. All non-owner members are stored as `admin`; access is the `permissions` JSON per module (`products`, `orders`, `customers`, `settings`) with levels `none/read/write`. | `permissions.ts`, `enums.ts` |
| Platform Admin | Separate table `platform_admins(user_id, role: super_admin \| admin)`. Asked only through `public.is_platform_admin()` / `public.platform_admin_role()`, which read `auth.uid()`. An organization member cannot also be a platform admin (`member_cannot_be_platform_admin`). | `lib/auth/platform.ts` |
| Route protection | Optimistic redirect in `proxy.ts`; real checks in `requireWorkspace*`, `requirePlatformAdmin`, `requireSuperAdmin`, `withTenantDb({permission})`, then RLS. | `tenant/context.ts` |
| Expired session | `getUser()` returns null -> `UNAUTHENTICATED` "Your session has expired" / redirect to `/login`. | `tenant-db.ts` |
| Suspended organization | Invisible to all members at the DB level (`is_tenant_member`). Disabled membership grants nothing. | `enums.ts` comments |
| Password change | Self-service: re-verify current password with `signInWithPassword`, then `updateUser({password})`. Admin-assisted reset via `auth.admin.updateUserById`. Password rule: 8-72 chars, a letter and a digit. | `auth.service.ts`, `validations/auth.ts` |
| SDK vs API routes | **Direct Supabase SDK from server actions.** There are no application auth API routes. | - |
| Service role key | Read in exactly one module; used only for `auth.admin.*`. Never for queries. | `lib/supabase/admin.ts` |

## Consequences for the API

1. The browser (future frontend) keeps signing in/out/refreshing through the Supabase SDK; the API only **verifies** the resulting access token.
2. The "user" for authorisation is the verified `sub`. Roles/permissions/platform-admin status come from Postgres every request.
3. The DB boundary (RLS + SECURITY DEFINER functions) must stay in force. A privileged `postgres` connection would bypass all of it, so the API refuses to start with one (same guard as the Next.js app).
