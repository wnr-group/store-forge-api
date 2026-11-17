# API Endpoint Inventory

Base path `/api/v1`. All JSON. Success envelope `{success,message,data,meta?}`; error envelope `{success:false,message,error:{code,details},timestamp,path}`.

* **Auth** column: `Public`, `JWT` (Supabase bearer token), `JWT+Org` (also resolves organization membership; optional `X-Organization-Id` hint).
* **Swagger** is mandatory for every row (tags, operation, DTOs, error responses, bearer auth, permission text). `test/swagger.e2e-spec.ts` fails if a route lacks a summary, description, tag, 2xx/401/500 responses, bearer auth (protected routes), path parameters, a request body or the standard envelope.
* **Status: every row below is Implemented and Tested** (at least one end-to-end request succeeded against it; measured by `npm run coverage:routes`, 74 of 74). Negative paths (401/403/404/409/400/429) are covered separately; see `API_READINESS_REPORT.md`.
* Source = existing function the rule is ported from. DB = tables / SQL functions.

## Public / health

| # | Module | Feature | Method + endpoint | Auth | Permission | Request | Response | DB | Business logic (source) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | health | Liveness (no dependencies) | GET `/health` | Public | - | - | `{status, service}` | - | process is up |
| 74 | health | Readiness (database) | GET `/health/ready` | Public | - | - | `{status, service, database}`; 503 when the DB is down | `select 1` through the RLS-guarded path | new infra |
| 2 | public | Platform branding | GET `/public/branding` | Public | - | - | `{platformName, supportEmail}` | `get_public_platform_settings()` | defaults to `StoreForge` if DB fails (`getPublicBranding`) |
| 3 | public | Public storefront | GET `/public/storefronts/:slug` | Public | - | slug | storefront JSON or 404 | `get_public_storefront(slug)` | unknown/inactive/suspended look identical (404); runs as no-identity request role |

## Auth & profile

| # | Module | Feature | Endpoint | Auth | Permission | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 4 | auth | Who am I | GET `/auth/me` | JWT | - | - | `{id,email,platformAdminLevel,memberships[]}` | memberships+tenants, `platform_admin_role()` | `listMembershipsForUser`, `getPlatformAdminLevel` |
| 5 | auth | Change own password | POST `/auth/change-password` | JWT | self | `{currentPassword,password,confirmPassword}` | `{}` | Supabase Auth | re-verify current; new != current; 8-72 chars, letter+digit (`changePassword`) |
| 6 | users | Read own profile | GET `/users/me` | JWT | self | - | `{id,email,fullName}` | `profiles` | `getOwnProfile` |
| 7 | users | Update own name | PATCH `/users/me` | JWT | self | `{fullName}` 2-120 | profile | `profiles`, Auth metadata | RLS own row; Auth metadata kept in step (best effort) (`updateOwnName`) |

## Cookie session (added with the authentication migration)

| # | Feature | Endpoint | Auth | Request | Response | Logic |
|---|---|---|---|---|---|---|
| 75 | Sign in (existing accounts only) | POST `/auth/login` | Public + origin/secret check | `{email, password}` | safe profile; **HttpOnly cookies** | Supabase password grant; DB login rate limit counted first; never creates users/orgs |
| 76 | Sign out | POST `/auth/logout` | Public + origin/secret check | - | `{signedOut}` | revokes at Supabase, always clears cookies |
| 77 | Refresh session | POST `/auth/refresh` | Public + origin/secret check | - (cookie) | `{user, expiresAt}`; new cookies | refresh token rotation; used/revoked -> cookies cleared, 401 `SESSION_EXPIRED` |
| 78 | Verify session | GET `/auth/session` | JWT (Bearer or cookie) | - | `{user:{id,email,fullName}, expiresAt}` | local signature/issuer/audience/expiry check, no database |

## Workspace & store

| # | Module | Feature | Endpoint | Auth | Permission | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 8 | organizations | My organizations | GET `/organizations` | JWT | any | - | memberships[] | `memberships`,`tenants` | ordered by joined date |
| 9 | organizations | Current organization + store + access | GET `/organizations/current` | JWT+Org | `dashboard:view` (any active member) | - | `{organization, role, permissions, access[], store}` | `memberships`,`tenants`,`stores` | `resolveActiveTenant`; primary store = oldest |
| 10 | store | Read store (+ currency lock flag) | GET `/store` | JWT+Org | any member | - | store + `currencyLocked` | `stores`,`products`,`orders` | `isCurrencyLocked` |
| 11 | store | Update store settings | PATCH `/store` | JWT+Org | `store:manage` | `{name,slug,description,contactEmail,contactPhone,currency,timezone,logoPath}` | store | `stores`,`store_template_settings`(read),storage | row lock; logo must be direct child of `{tenant}/store`; slug availability fn; currency locked after products/orders; valid IANA tz; old logo removed after commit if unreferenced |

## Team (Owner only)

| # | Feature | Endpoint | Request | Logic |
|---|---|---|---|---|
| 12 | List team | GET `/team/members` | - | `list_tenant_team` |
| 13 | Create member | POST `/team/members` | `{fullName,email,password,permissions}` | Auth user created confirmed, membership role `admin`; compensating delete on failure; email conflict -> 409 |
| 14 | Edit member | PATCH `/team/members/:userId` | `{fullName,permissions}` | never owner, never self; `update_team_member_name`; Auth name synced |
| 15 | Enable/disable | PATCH `/team/members/:userId/status` | `{status: active\|disabled}` | never owner/self |
| 16 | Remove | DELETE `/team/members/:userId` | - | `remove_team_member`; Auth user deleted if orphaned after commit; `cannot_remove_self` |
| 17 | Reset password | POST `/team/members/:userId/password` | `{password}` | target must be a non-owner member of this org |

All: Auth `JWT+Org`, permission `members:manage`. DB `memberships`, `profiles`, Auth Admin API.

## Catalog (Auth `JWT+Org`)

| # | Feature | Endpoint | Permission | Request | Logic |
|---|---|---|---|---|---|
| 18 | List categories | GET `/categories` | `catalog:view` | - | with `productCount`, `parentName` |
| 19 | Get category | GET `/categories/:id` | `catalog:view` | - | 404 if other tenant |
| 20 | Create | POST `/categories` | `catalog:manage` | `{name<=80,slug?,description?,parentId?}` | cycle check; slug default `slugify(name)` padded to 2 |
| 21 | Update | PATCH `/categories/:id` | `catalog:manage` | same | cycle check |
| 22 | Delete | DELETE `/categories/:id` | `catalog:delete` | - | products uncategorised, children top-level |
| 23 | List collections | GET `/collections` | `catalog:view` | - | with `productCount` |
| 24 | Get collection | GET `/collections/:id` | `catalog:view` | - | with ordered `productIds` |
| 25 | Create | POST `/collections` | `catalog:manage` | `{id?,name,slug?,description?,status,imagePath?,productIds[]}` | image path verified under advisory lock; products must be in tenant |
| 26 | Update | PATCH `/collections/:id` | `catalog:manage` | same | replaces product set; old image removed after commit if unreferenced |
| 27 | Delete | DELETE `/collections/:id` | `catalog:delete` | - | image removed after commit if unreferenced |
| 28 | Product choices | GET `/collections/product-options` | `catalog:view` | - | `{id,name}` first 500 by name |
| 29 | List products | GET `/products?page&limit&search&status&category&stock&sortBy&sortOrder` | `catalog:view` | - | search name/SKU (LIKE-escaped); stock `in/low/out/untracked` by effective stock; sort created/name/price; page size default 20 |
| 30 | Get product | GET `/products/:id` | `catalog:view` | - | product + options + variants + images + collectionIds |
| 31 | Create product | POST `/products` | `catalog:manage` | `ProductInput` (client-generated `id`, decimal-text prices, options<=3, variants<=100, images<=10) | one transaction: verify images under lock, category in tenant, unique slug, options, images (first = primary), variants, collections; money parsed with store currency digits; compare-at > price; variants imply `sku=null`, `quantity=0` on product |
| 32 | Update product | PATCH `/products/:id` | `catalog:manage` | `ProductInput` | same sync; removed image files deleted after commit if unreferenced |
| 33 | Delete product | DELETE `/products/:id` | `catalog:delete` | - | image files removed after commit |
| 34 | Bulk delete | POST `/products/bulk-delete` | `catalog:delete` | `{ids[1..100]}` | returns `{deleted}` |
| 35 | Bulk status | POST `/products/bulk-status` | `catalog:manage` | `{ids[],status}` | returns `{updated}` |
| 36 | Duplicate | POST `/products/:id/duplicate` | `catalog:manage` | - | draft copy "(copy)", `sku=null`, no images |
| 37 | Signed upload URLs | POST `/uploads/signed-urls` | `catalog:manage` (scope store: `store:manage`) | `{scope: product\|collection\|store, ownerId?, files:[{type,size}]}` 1-10 files, jpeg/png/webp, <=5 MB | folder derived from verified tenant, never from input; Storage called with caller's token |
| 38 | Stock list | GET `/inventory?search&stock&page` | `catalog:view` | - | one row per sellable unit (simple product or active variant) |
| 39 | Adjustment ledger | GET `/inventory/adjustments?limit` | `catalog:view` | - | newest first |
| 40 | Adjust stock | POST `/inventory/adjustments` | `catalog:manage` | `{productId,variantId?,mode:add\|set,value,reason,note?}` | `FOR UPDATE`; tracked only; variant required iff product has variants; never < 0; zero delta rejected; ledger row same transaction |

## Customers & analytics (Auth `JWT+Org`)

| # | Feature | Endpoint | Permission | Logic |
|---|---|---|---|---|
| 41 | List customers `?page&limit&search&sortBy(created,name,spent,orders)&sortOrder` | GET `/customers` | `customers:view` | order count / spend (paid+fulfilled) / last order computed in SQL |
| 42 | Get customer + last 50 orders | GET `/customers/:id` | `customers:view` | - |
| 43 | Create | POST `/customers` | `customers:manage` | email unique per tenant, case-insensitive -> 409 |
| 44 | Update | PATCH `/customers/:id` | `customers:manage` | - |
| 45 | Delete | DELETE `/customers/:id` | `customers:delete` | orders keep rows, `customer_id` null |
| 46 | Analytics / dashboard overview `?range=7\|30\|90` | GET `/analytics` | `orders:view` (original shows the section only to members who can view orders) | revenue = paid+fulfilled; zero-filled series in store timezone; best sellers top 5; recent 8; low-stock list |

## Platform Admin (Auth `JWT` + `@PlatformAdmin`; mutating rows are rate-limited via `rate_limit_admin` first)

| # | Feature | Endpoint | Level | Bucket | Logic |
|---|---|---|---|---|---|
| 47 | My admin level | GET `/platform/me` | admin | - | `platform_admin_role()` |
| 48 | Overview | GET `/platform/overview` | admin | - | stats + 5 newest orgs |
| 49 | List orgs `?q&status&sortBy&sortOrder&page&limit` | GET `/platform/organizations` | admin | - | SQL paging; page past end clamps to last page |
| 50 | Create org + owner | POST `/platform/organizations` | admin | org.create | slug pre-check; Auth user -> `platform_provision_tenant` (idempotent, one retry on ambiguous failure) -> delete Auth user on failure; audit `organization.created` |
| 51 | Org detail | GET `/platform/organizations/:id` | admin | - | company + store + team |
| 52 | Update org | PATCH `/platform/organizations/:id` | admin | org.edit | no write/audit when unchanged; audit `organization.updated` |
| 53 | Delete org | DELETE `/platform/organizations/:id` | admin | org.delete | `platform_delete_tenant`; then delete orphaned Auth users and storage objects (best effort) |
| 54 | Suspend / reactivate | PATCH `/platform/organizations/:id/status` | admin | org.edit | audit suspended/reactivated only on change |
| 55 | Edit store | PATCH `/platform/organizations/:id/store` | admin | org.edit | name, description, contacts, currency, timezone (not slug/logo); currency lock |
| 56 | Add member | POST `/platform/organizations/:id/members` | admin | team.manage | Auth user -> `platform_add_member` + audit in one tx; compensate |
| 57 | Member status | PATCH `/platform/organizations/:id/members/:userId/status` | admin | team.manage | owner cannot be disabled |
| 58 | Remove member | DELETE `/platform/organizations/:id/members/:userId` | admin | team.manage | owner cannot be removed; orphan Auth user deleted |
| 59 | Transfer ownership | POST `/platform/organizations/:id/ownership/transfer` | admin | ownership.change | target active non-owner; `previousOwner keep\|disable`; audit |
| 60 | Recover owner | POST `/platform/organizations/:id/ownership/recover` | admin | ownership.change | new confirmed account becomes owner; compensate |
| 61 | Org usage | GET `/platform/organizations/:id/usage` | admin | - | counts/bytes only, storage `null` when unmeasurable |
| 62 | List admins | GET `/platform/admins` | admin | - | - |
| 63 | Add admin | POST `/platform/admins` | **super_admin** | admin.manage | member of an org cannot become admin |
| 64 | Change level | PATCH `/platform/admins/:userId` | **super_admin** | admin.manage | last super admin protected; no-op when same |
| 65 | Remove admin | DELETE `/platform/admins/:userId` | **super_admin** | admin.manage | audit first, then remove, then delete Auth user |
| 66 | Read settings | GET `/platform/settings` | admin | - | - |
| 67 | Update settings | PATCH `/platform/settings` | **super_admin** | settings.update | diff-only audit |
| 68 | Audit log `?action&admin&org&q&from&to&page&limit` | GET `/platform/audit-logs` | admin | - | append-only |
| 69 | Audit admins | GET `/platform/audit-logs/admins` | admin | - | filter dropdown |
| 70 | Usage table | GET `/platform/usage` | admin | - | - |
| 71 | Usage summary `?inactiveDays=30\|60\|90` | GET `/platform/usage/summary` | admin | - | - |
| 72 | Inactive orgs `?days&limit` | GET `/platform/usage/inactive` | admin | - | - |
| 73 | New-org series `?from&to` | GET `/platform/usage/new-organizations` | admin | - | bucket from `resolveSeriesRange` |

**Total identified: 78** (the 73 migrated features + the readiness probe + the 4 cookie-session routes below). See [COOKIE_SESSION_AUTH.md](COOKIE_SESSION_AUTH.md). Intentionally absent: sign in/out/refresh (Supabase SDK), anything template-related, orders CRUD, billing/subscriptions/integrations.

## Theme Store and store design

Built on the template engine tables (migrations 0010-0016) plus the theme catalogue (0025). Reading needs `dashboard:view`; changing anything needs `store:manage`. A page is always the caller's own store; ids from other organizations answer 404. Drafts carry a `revision` for optimistic concurrency (409 `TEMPLATE_REVISION_CONFLICT`).

| # | Module | Feature | Method + endpoint | Auth | Permission | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 79 | themes | Browse the catalogue (paginated, filter, search) | GET `/themes` | JWT+Org | `dashboard:view` | `page,limit,search,industry` | theme summaries + `meta` | `themes`, `store_themes` | same list for every tenant; `isCurrent` marks the store's theme |
| 80 | themes | One theme with its documents (preview) | GET `/themes/:slug` | JWT+Org | `dashboard:view` | slug | theme + documents | `themes` | read-only |
| 81 | themes | Current theme | GET `/store/theme` | JWT+Org | `dashboard:view` | - | `{theme, appliedVersion, appliedAt, updateAvailable}` | `store_themes` | - |
| 82 | themes | Apply a theme | POST `/store/theme` | JWT+Org | `store:manage` | `{themeSlug}` | `{theme, draftsWritten, draftsReplaced}` | `templates`, `store_themes` | copies documents into drafts; never publishes; no commerce data touched |
| 83 | themes | Publish the whole theme | POST `/store/theme/publish` | JWT+Org | `store:manage` | `{label?}` | `{published[], unchanged, storeSlug, publishedAt}` | `template_versions`, `templates` | one transaction; validates everything first |
| 84 | design | List pages and shared parts | GET `/store/templates` | JWT+Org | `dashboard:view` | - | summaries with publication state | `templates`, `template_versions` | one query, no N+1 |
| 85 | design | Open one page | GET `/store/templates/:id` | JWT+Org | `dashboard:view` | id | draft + revision | `templates` | - |
| 86 | design | Preview bundle | GET `/store/templates/:id/preview` | JWT+Org | `dashboard:view` | id | page + theme settings + groups (drafts) | `templates` | members only |
| 87 | design | Save a draft | PUT `/store/templates/:id/draft` | JWT+Org | `store:manage` | `{document, expectedRevision}` | draft | `templates` | validated; 409 on stale revision; unchanged draft keeps the revision |
| 88 | design | Publish one page | POST `/store/templates/:id/publish` | JWT+Org | `store:manage` | `{label?, expectedRevision?}` | `{published[], unchanged, ...}` | `template_versions`, `templates` | immutable numbered version |
| 89 | design | Publishing history | GET `/store/templates/:id/versions` | JWT+Org | `dashboard:view` | id | last 100 versions, `isLive` | `template_versions` | - |
| 90 | design | Restore a version | POST `/store/templates/:id/rollback` | JWT+Org | `store:manage` | `{versionId, label?}` | `{published[], ...}` | `template_versions`, `templates` | republished as a new version; history is append-only |
| 91 | public | Published design of a store page | GET `/public/storefronts/:slug/layout?kind=&resource=` | Public | - | `kind` index/product/collection | `{source, template, theme, groups}` (published only) | `get_public_template_layout()` | no identity; drafts never returned; unknown store 404 |
| 92 | public | Public collections | GET `/public/storefronts/:slug/collections` | Public | - | slug | collections with product counts | `get_public_collections()` | unknown/inactive store 404 |
| 93 | public | Public product | GET `/public/storefronts/:slug/products/:productSlug` | Public | - | slug, productSlug | product, images, options, variants, related | `get_public_product()` | active products only; unknown/inactive store or product 404 |
| 94 | public | Public collection | GET `/public/storefronts/:slug/collections/:collectionSlug` | Public | - | slug, collectionSlug | collection with its active products | `get_public_collection()` | active collections only; unknown/inactive store or collection 404 |
| 95 | public | Public content pages | GET `/public/storefronts/:slug/pages` | Public | - | slug | published pages (title, slug) | `get_public_pages()` | published only; unknown/inactive store 404 |
| 96 | public | Public content page | GET `/public/storefronts/:slug/pages/:pageSlug` | Public | - | slug, pageSlug | `{store, page}` | `get_public_page()` | published only; drafts 404 |
| 97 | store-design | List content pages | GET `/store/pages` | `dashboard:view` | org | - | pages incl. drafts | `store_pages` (RLS) | own store only |
| 98 | store-design | View a content page | GET `/store/pages/:id` | `dashboard:view` | org | id | page | `store_pages` (RLS) | other tenant 404 |
| 99 | store-design | Add a content page | POST `/store/pages` | `store:manage` | org | title, slug?, body?, status? | page (201) | `store_pages` (RLS) | reserved/duplicate address rejected |
| 100 | store-design | Change a content page | PATCH `/store/pages/:id` | `store:manage` | org | title?, slug?, body?, status? | page | `store_pages` (RLS) | other tenant 404 |
| 101 | store-design | Remove a content page | DELETE `/store/pages/:id` | `store:manage` | org | id | - | `store_pages` (RLS) | other tenant 404 |
