# Existing Features Audit

Source: `D:\store-forge` (Next.js 16, App Router), read-only. Audited 2026-11-10.

## 1. How the backend is shaped today

| Question | Finding |
|---|---|
| Next.js API routes (`app/api`) | **None exist.** |
| Server actions | 12 `actions.ts` files under `app/(auth)`, `app/(admin)`, `app/(dashboard)/**`. Each is a thin wrapper: Zod parse -> service -> `run()` (safe error mapping). |
| Service layer | `services/*.service.ts` holds all business logic and all queries. This is what the NestJS services port. |
| Data access | Drizzle over `postgres-js`, connected as the restricted login role `storeforge_app` through the Supabase transaction pooler. Every request runs in a transaction that publishes the user id as `request.jwt.claims` and does `SET LOCAL ROLE authenticated`, so **Postgres RLS is the real authorisation boundary** (`lib/db/user-context.ts`). |
| Business rules in SQL | Many rules live in `SECURITY DEFINER` functions (`platform_*`, `list_tenant_team`, `remove_team_member`, `update_team_member_name`, `is_store_slug_available`, `rate_limit_*`, `get_public_storefront`, ...). They must be **called, not re-implemented**. |
| Supabase usage | Auth only (`signInWithPassword`, `signOut`, `getUser`, `getClaims`, `updateUser`) with the user's cookie session; Admin Auth API (service role) for provisioning; Storage (signed upload URLs, list, remove) with the user's session. No `supabase.from()` queries. |
| Client-side API calls | None; the browser calls server actions only. |
| Middleware | `proxy.ts` + `lib/supabase/middleware.ts`: refresh session cookies, optimistic redirect of signed-out users from `/dashboard`, `/admin`, `/no-workspace`; host-based store resolution. UX only; every data call re-authorises. |

## 2. Feature inventory

| # | Module | Feature | Source | Migrated? |
|---|---|---|---|---|
| 1 | Auth | Sign in, sign out, refresh | `(auth)/actions.ts`, `auth.service.ts` | **Stays in Supabase SDK** (see AUTHENTICATION_*) |
| 2 | Auth | Change own password (re-verifies current password) | `auth.service.changePassword` | Yes |
| 3 | Auth | Login rate limit (`rate_limit_login`, 8 / 40 per 15 min) | `security/rate-limit.ts` | Not applicable: login is not performed by the API (Supabase applies its own limits) |
| 4 | Profile | Read/update own display name | `profile.service.ts` | Yes |
| 5 | Workspace | List my memberships, resolve active tenant | `tenant.service.ts`, `tenant/context.ts` | Yes (header-based, see ROLE_PERMISSION_MATRIX) |
| 6 | Store | Primary store read; update settings (name, slug, description, contact, currency, timezone, logo) with currency lock | `store.service.ts`, `store-settings.service.ts` | Yes |
| 7 | Team | Owner creates/edits/disables/removes members, resets passwords | `team.service.ts` | Yes |
| 8 | Categories | CRUD with cycle check | `category.service.ts` | Yes |
| 9 | Collections | CRUD, product assignment, image | `collection.service.ts` | Yes |
| 10 | Products | List (search/filter/sort/page), detail, create/update (options, variants, images, collections), bulk delete, bulk status, duplicate | `product.service.ts` | Yes |
| 11 | Uploads | Signed upload URLs; object verification; reference-protected removal | `lib/storage/*`, `storage-references.service.ts`, `uploads/actions.ts` | Yes |
| 12 | Inventory | Stock list (per sellable unit), adjustment ledger, adjust stock | `inventory.service.ts` | Yes |
| 13 | Customers | List with order aggregates, detail with order history, CRUD | `customer.service.ts` | Yes |
| 14 | Analytics / Dashboard | Sales series, best sellers, recent orders, low stock (dashboard overview = analytics, 30 days) | `analytics.service.ts` | Yes |
| 15 | Public storefront | `get_public_storefront(slug)` | `storefront.service.ts` | Yes (public, unauthenticated) |
| 16 | Platform branding | Public name + support e-mail | `platform-settings.service.ts` | Yes (public) |
| 17 | Platform Admin | Overview stats, organizations list/detail/create/update/status/delete | `platform.service.ts` | Yes |
| 18 | Platform Admin | Store edit, member add/disable/remove, ownership transfer & recovery | `platform.service.ts` | Yes |
| 19 | Platform Admin | Admin accounts: list/add/change level/remove | `platform-team.service.ts` | Yes |
| 20 | Platform Admin | Platform settings read/update (super admin) | `platform-settings.service.ts` | Yes |
| 21 | Platform Admin | Audit log list + admin filter | `admin-audit.service.ts` | Yes |
| 22 | Platform Admin | Usage analytics (per-org, summary, inactive, new-org series) | `platform-usage.service.ts` | Yes |
| 23 | Platform Admin | Per-admin rate limits (`rate_limit_admin`) | `security/rate-limit.ts` | Yes |
| 24 | Templates | Template engine, drafts, versions, publish, store template settings | `storefront-template.service.ts`, `template-settings.service.ts`, `engine-cutover.service.ts`, `lib/templates/**` | **Excluded** (EXCLUDED_FEATURES.md) |

## 3. Features that do NOT exist (and therefore are not invented)

| Candidate in the brief | Reality in StoreForge |
|---|---|
| Self-registration / signup | None. Accounts are provisioned by a Platform Admin or Owner. |
| Email verification, forgot-password | None. Accounts are created pre-confirmed. |
| Member invitations | None. Owners create the account directly with an initial password. |
| Orders create/update/delete | **None.** Orders are read-only ("no checkout yet"): `authenticated` has no INSERT privilege. Orders surface only as customer history and analytics. There is no orders list page. |
| Subscriptions, billing, integrations | No tables, services or UI. |
| Reports | Covered by analytics only. |
| Staff role UI | `staff` exists in the `role` CHECK, but members are stored as `admin`; effective access is the per-module `permissions` JSON (presets Manager/Staff/Viewer are UI labels only). |

## 4. Cross-cutting behaviour that must be preserved

* Money: integer minor units; product input is decimal text parsed with the **store currency's** digit count.
* Currency is locked once the tenant has any product or order.
* Slugs: store slug 3-40 chars + reserved list; catalog slug 2-80 chars.
* All file paths live in the `products` bucket as `{tenant}/{product}/..`, `{tenant}/collections/{id}/..`, `{tenant}/store/..`; removal is blocked while anything (including template documents) references the path.
* Platform Admin writes and their audit entry commit in one transaction; auth-user creation is compensated (deleted) on DB failure.
* Errors: `AppError` codes `UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, VALIDATION, CONFLICT, RATE_LIMITED, UNKNOWN`; DB constraint names are mapped to safe messages (`lib/db/errors.ts`).
