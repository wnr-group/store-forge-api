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
| 2a | public | Subscription plans on offer | GET `/public/plans` | Public | - | - | array of `{code, name, description, currency, monthlyPrice, yearlyPrice, trialDays, features[], limits[]}` | `get_public_plans()` | only active, restricted plans (an admin "publishes" a plan by making it active); no ids or subscriber counts; limit `null` = unlimited; read-only, no purchase |
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
| 75a | Create my account (self-service, no email verification) | POST `/auth/register` | Public + origin/secret check | `{fullName, email, password, confirmPassword, acceptTerms}` | safe profile; **HttpOnly cookies** | creates a confirmed Supabase user (terms acceptance time kept in user metadata) and signs it in; creates NO organization, membership or role; counted against the login limits; throttled |
| 76 | Sign out | POST `/auth/logout` | Public + origin/secret check | - | `{signedOut}` | revokes at Supabase, always clears cookies |
| 77 | Refresh session | POST `/auth/refresh` | Public + origin/secret check | - (cookie) | `{user, expiresAt}`; new cookies | refresh token rotation; used/revoked -> cookies cleared, 401 `SESSION_EXPIRED` |
| 78 | Verify session | GET `/auth/session` | JWT (Bearer or cookie) | - | `{user:{id,email,fullName}, expiresAt}` | local signature/issuer/audience/expiry check, no database |
| 78a | Get a one-time code to open my store | POST `/auth/handoff` | JWT (Bearer or cookie) | - | `{audience}` (the store host label) | `{code, expiresInSeconds}` | `memberships`, `stores`; Supabase Auth admin | only an active member of the store that owns the host; the code is signed, works once, for that host only, for 60 seconds; throttled |
| 78b | Sign a store host in with a code | POST `/auth/handoff/exchange` | Public + origin/secret check (trusted Next.js server only) | - | `{code, audience}` | `{id, email, expiresAt}`; new host-only cookies | Supabase Auth | wrong, used, expired or other-host code -> 401 `HANDOFF_INVALID`; the session on the root site is untouched; throttled |

## Self-service sign-up (migration 0070)

A registered person with no organization buys a plan, then names a store. Needs a signed-in person but no organization; every route works only on the caller's own purchase. The price is worked out in the database; the browser never sends one.

| # | Feature | Endpoint | Auth | Request | Logic |
|---|---|---|---|---|---|
| 160 | Where am I in the sign-up | GET `/signup/status` | JWT | - | `none`, `payment_required`, `store_required` or `provisioned`, from the caller's own purchase |
| 161 | Choose a plan and start paying | POST `/signup/checkout` | JWT | `{planCode, billingInterval}` | published plans only; price and tax from the plan and billing settings; reuses the open Razorpay order (retry after a failed payment); free plans skip payment; platform staff refused |
| 162 | Confirm a payment | POST `/signup/verify-payment` | JWT | `{razorpayOrderId, razorpayPaymentId, razorpaySignature}` | order must be the caller's own; checkout signature, then a lookup at Razorpay (captured, same order and amount); idempotent. Razorpay's signed webhook (`/webhooks/billing/razorpay`) reaches the same result |
| 163 | Create my store | POST `/signup/store` | JWT | `{storeName}` | refused until paid; one SQL routine (shared with Platform Admin creation) makes tenant, Owner membership and store; the paid plan becomes the active subscription and a paid invoice is recorded; store address made from the name (suffix on a clash); idempotent |

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
| 27 | Delete | DELETE `/collections/:id` | `catalog:delete` | optional `?usage=<64-hex>` | image removed after commit if unreferenced; 409 `COLLECTION_IN_USE` while the store design uses the collection unless `usage` matches the current usage hash |
| 27a | Usage | GET `/collections/:id/usage` | `catalog:manage` | - | draft and published product-list sections that use the collection, with a `hash` to confirm a delete |
| 28 | Product choices | GET `/collections/product-options` | `catalog:view` | - | `{id,name}` first 500 by name |
| 29 | List products | GET `/products?page&limit&search&status&category&stock&sortBy&sortOrder` | `catalog:view` | - | search name/SKU (LIKE-escaped); stock `in/low/out/untracked` by effective stock; sort created/name/price; page size default 20 |
| 30 | Get product | GET `/products/:id` | `catalog:view` | - | product + options + variants + images + collectionIds |
| 31 | Create product | POST `/products` | `catalog:manage` | `ProductInput` (client-generated `id`, decimal-text prices, options<=3, variants<=100, images<=10) | one transaction: verify images under lock, category in tenant, unique slug, options, images (first = primary), variants, collections; money parsed with store currency digits; compare-at > price; variants imply `sku=null`, `quantity=0` on product |
| 32 | Update product | PATCH `/products/:id` | `catalog:manage` | `ProductInput` | same sync; removed image files deleted after commit if unreferenced |
| 33 | Delete product | DELETE `/products/:id` | `catalog:delete` | - | image files removed after commit |
| 34 | Bulk delete | POST `/products/bulk-delete` | `catalog:delete` | `{ids[1..100]}` | returns `{deleted}` |
| 35 | Bulk status | POST `/products/bulk-status` | `catalog:manage` | `{ids[],status}` | returns `{updated}` |
| 36 | Duplicate | POST `/products/:id/duplicate` | `catalog:manage` | - | draft copy "(copy)", `sku=null`, no images |
| 36a | Import products | POST `/products/import` | `catalog:manage` | `{rows[1..500]}` (snake_case file headers, `row` number, optional `source_errors`) | `{count}`; every row validated first, all-or-nothing in one transaction; 2 MB body limit on this route only; 400 `PRODUCT_IMPORT_INVALID` with `{total, errors[<=500]}`; products of one import share one `created_at` |
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
| 49 | List orgs `?q&status&sortBy&sortOrder&page&limit` | GET `/platform/organizations` | admin | - | SQL paging; page past end clamps to last page; search matches name, slug, tenant id, public id, owner e-mail, store domain |
| 50 | Create org + owner | POST `/platform/organizations` | admin | org.create | slug pre-check; Auth user -> `platform_provision_tenant` (idempotent, one retry on ambiguous failure) -> delete Auth user on failure; audit `organization.created` |
| 51 | Org detail | GET `/platform/organizations/:id` | admin | - | company + store + team |
| 52 | Update org | PATCH `/platform/organizations/:id` | admin | org.edit | no write/audit when unchanged; audit `organization.updated` |
| 53 | Delete org | DELETE `/platform/organizations/:id` | admin | org.delete | `platform_delete_tenant`; then delete orphaned Auth users and storage objects (best effort); audit `organization.deleted` is written first, in the same transaction |
| 53a | Org activity history `?page&limit` | GET `/platform/organizations/:id/activity` | `tenants:read` | - | the audit log narrowed to one organization; survives deletion |
| 53b | Plan catalog (features and limits a plan can use) | GET `/platform/plan-catalog` | `plans:read` | - | capabilities defined in code (`plan-catalog.ts`); which plan has what is data |
| 53c | List plans `?status&search&page&limit` | GET `/platform/plans` | `plans:read` | - | with features, limits and subscriber counts |
| 53d | Plan detail | GET `/platform/plans/:id` | `plans:read` | - | - |
| 53e | Create plan | POST `/platform/plans` | `plans:manage` | plan.manage | prices as decimal text; one transaction with its audit entry; `PLAN_CODE_TAKEN` on a duplicate code |
| 53f | Edit plan | PATCH `/platform/plans/:id` | `plans:manage` | plan.manage | partial; only differences written and audited; default plan always exists |
| 53g | Activate / deactivate plan | PATCH `/platform/plans/:id/status` | `plans:manage` | plan.manage | default plan cannot be deactivated; existing subscribers keep it |
| 53h | Organization subscription | GET `/platform/organizations/:id/subscription` | `subscriptions:read` | - | every tenant has exactly one (trigger on tenant insert) |
| 53i | Put organization on a plan | PUT `/platform/organizations/:id/subscription` | `subscriptions:manage` | subscription.manage | `platform_assign_plan`; active plans only; audit `subscription.created` / `subscription.changed` |
| 53j | What my plan includes and my usage `?storage` | GET `/entitlements` | any member (`dashboard:view`) | - | features, limits, used/percent/level, `attention`; for display only, the server enforces |
| 53k | What an organization may use | GET `/platform/organizations/:id/entitlements` | `subscriptions:read` | - | effective features and limits with usage (storage included) and the exceptions set for it |
| 53l | Feature exception for one organization | PUT `/platform/organizations/:id/entitlements/features/:key` | `entitlements:manage` | subscription.manage | `enabled` true / false / null (remove); wins over the plan; no-op not logged |
| 53m | Limit exception for one organization | PUT `/platform/organizations/:id/entitlements/limits/:key` | `entitlements:manage` | subscription.manage | soft/hard, both empty = unlimited, `clear` removes it |
| 53n | Organizations close to their limits `?filter&search&page&limit` | GET `/platform/limit-usage` | `usage:read` | - | products, staff, orders this month; filter all / attention / warning / reached |
| 53o | Platform overview `?from&to` | GET `/platform/dashboard` | `tenants:read` | - | tenants, users, subscriptions by state, growth, billing (if `billing:read`), recent activity (if `audit:read`), health |
| 53p | Billing summary `?from&to` | GET `/platform/billing/summary` | `billing:read` | - | MRR, collected, failed, pending, refunded, overdue |
| 53q | Billing settings | GET `/platform/billing/settings` | `billing:read` | - | seller, tax, due/grace days; never the Razorpay keys |
| 53r | Update billing settings | PUT `/platform/billing/settings` | `billing:manage` | billing.manage | only differences written and audited |
| 53s | List invoices `?status&org&from&to&search&page&limit` | GET `/platform/billing/invoices` | `billing:read` | - | status `overdue` = open and past due |
| 53t | Invoice detail | GET `/platform/billing/invoices/:id` | `billing:read` | - | with payments and refunds |
| 53u | Download invoice (PDF) | GET `/platform/billing/invoices/:id/download` | `billing:read` | - | built from stored records only |
| 53v | Void an open invoice | POST `/platform/billing/invoices/:id/void` | `billing:manage` | billing.manage | audit `invoice.voided` |
| 53w | Record an offline payment | POST `/platform/billing/invoices/:id/payments` | `billing:manage` | billing.manage | settles the invoice, extends the subscription; audit `payment.manual_recorded` |
| 53x | Issue an invoice for an organization | POST `/platform/organizations/:id/billing/invoices` | `billing:manage` | billing.manage | `current` or `next` period; one invoice per period; audit `invoice.issued` |
| 53y | An organization billing position | GET `/platform/organizations/:id/billing` | `billing:read` | - | plan, renewal date, overdue, latest invoices and payments |
| 53z | List payments `?status&org&from&to&search&refundRequired` | GET `/platform/billing/payments` | `billing:read` | - | successful, failed, pending, refunded |
| 54a | Payment detail | GET `/platform/billing/payments/:id` | `billing:read` | - | with refunds |
| 54b | Refund a payment | POST `/platform/billing/payments/:id/refund` | `billing:manage` | billing.manage | idempotent by `requestId`; Razorpay or bookkeeping for offline; audit `payment.refunded` |
| 54c | Run billing now | POST `/platform/billing/run` | `billing:manage` | billing.manage | renewals, past due, expiry; same as the scheduler |
| 54d | My plan and what I owe | GET `/billing/overview` | Owner (`billing:manage`) | - | plan read through the member-safe entitlement function |
| 54e | My invoices | GET `/billing/invoices` | Owner (`billing:manage`) | - | own organization only |
| 54f | One of my invoices | GET `/billing/invoices/:id` | Owner (`billing:manage`) | - | - |
| 54g | Download one of my invoices | GET `/billing/invoices/:id/download` | Owner (`billing:manage`) | - | PDF |
| 54h | My payments | GET `/billing/payments` | Owner (`billing:manage`) | - | - |
| 54i | Start paying an invoice | POST `/billing/invoices/:id/pay` | Owner (`billing:manage`) | throttled | creates or reuses one Razorpay order; returns order id and PUBLIC key id; 503 `BILLING_PAYMENTS_UNAVAILABLE` without keys |
| 54j | Confirm a payment | POST `/billing/payments/verify` | Owner (`billing:manage`) | throttled | checkout signature, then a lookup at Razorpay; idempotent |
| 54k | Razorpay webhooks for StoreForge billing | POST `/webhooks/billing/razorpay` | public, signed | throttled | signature over the raw body; one row per event id; `internal/jobs/billing` (cron) is hidden from the docs |
| 54l | Activity log filter options | GET `/platform/audit-logs/filters` | `audit:read` | - | every action and entity type, for filter lists |
| 54m | Platform health, services, errors, jobs and alerts | GET `/platform/monitoring/overview` | `monitoring:read` | - | built to be polled; measured vs configured vs not measured; no secrets |
| 54n | Recent server errors `?search&page&limit` | GET `/platform/monitoring/errors` | `monitoring:read` | - | route template, class, sanitised message, request id |
| 54o | Scheduled job runs `?job&status&page&limit` | GET `/platform/monitoring/jobs` | `monitoring:read` | - | recorded by the `/internal/jobs/*` routes |
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
| 67a | Get a logo upload link | POST `/platform/settings/logo/upload-url` | **super_admin** | settings.update | JPEG, PNG or WebP, at most 2 MB; one-time link |
| 67b | Set the logo | PUT `/platform/settings/logo` | **super_admin** | settings.update | uses the uploaded file; old file deleted; audited |
| 67c | Remove the logo | DELETE `/platform/settings/logo` | **super_admin** | settings.update | back to the built-in logo; file deleted; audited |
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
| 83 | themes | Publish the whole theme | POST `/store/theme/publish` | JWT+Org | `store:manage` | `{label?}` | `{published[], unchanged, storeSlug, publishedAt, productPresentations:{published}}` | `template_versions`, `templates`, `product_presentations` | one transaction; validates pages and product settings first |
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
| 102 | store-design | List customized products | GET `/store/product-presentations` | JWT+Org | `dashboard:view` | page, limit | paginated `{productId, revision, publicationState, publishedAt, updatedAt}` (no product names) | `product_presentations` (RLS) | own store only |
| 103 | store-design | Open one product design | GET `/store/product-presentations/:productId` | JWT+Org | `dashboard:view` | productId | `{productId, revision, publicationState, document, publishedDocument, publishedAt, updatedAt}`; default (revision 0) when never customized | `product_presentations` (RLS) | other tenant or unknown product 404 |
| 104 | store-design | Save a product design draft | PUT `/store/product-presentations/:productId/draft` | JWT+Org | `store:manage` | `{document, expectedRevision}` (0 to create) | detail | `product_presentations` (RLS) | closed schema; 400 `PRESENTATION_DOCUMENT_INVALID`; 409 `PRESENTATION_REVISION_CONFLICT`; unchanged draft keeps the revision |
| 105 | store-design | Publish a product design | POST `/store/product-presentations/:productId/publish` | JWT+Org | `store:manage` | `{expectedRevision?}` | detail + `published` flag | `product_presentations` (RLS) | 404 `PRESENTATION_NOT_FOUND` without a row; no-op when the draft equals the live copy; no history |
| 106 | store-design | Reset a product to the default design | DELETE `/store/product-presentations/:productId` | JWT+Org | `store:manage` | productId | default detail | `product_presentations` (RLS) | removes draft and live copy at once; idempotent |
| 107 | public | Find the store an address names | GET `/public/hosts/:subdomain` | Public | - | subdomain (host label `{store slug}-{public id}`) | `{slug, publicId}` or 404 | `get_public_store_by_subdomain()` (reads `stores.subdomain`) | unknown/inactive/suspended look identical (404); no identity; used by the web proxy to resolve a store host |

## Studio foundation (migration 0037)

Rollout flag, legal gate, attestations and Studio media. Store routes are `JWT+Org`; platform routes are Platform Admin only (403 otherwise, enforced again inside the SQL functions). The tables behind the rollout flag and the legal wording are not reachable by the app role at all.

| # | Module | Feature | Method + endpoint | Auth | Permission | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 108 | studio | Studio status for my store | GET `/store/studio/status` | JWT+Org | `design:view` | - | `{enabled, schemaV2Capable, schemaVersion, pointOfNoReturnAt, features}` | `studio_rollout_status()`, `is_feature_approved()` | default disabled (no row = off); `features` is `unavailable` until legal approval exists |
| 109 | studio | Turn Studio on/off for an organization | PUT `/platform/organizations/:id/studio-rollout` | JWT + Platform Admin | any Platform Admin | `{enabled, reason}` (reason 1-500) | `{storeId, enabled, enabledAt, pointOfNoReturnAt}` | `platform_set_studio_rollout()` | primary store; history row + audit entry `store.studio_rollout_changed` in the same transaction; disabling deletes nothing |
| 110 | studio | Rollout history | GET `/platform/organizations/:id/studio-rollout/events` | JWT + Platform Admin | any Platform Admin | `page, limit` | paginated events (action, reason, previous, new, actorId) | `platform_list_studio_rollout_events()` | append-only table; unknown organization 404 |
| 111 | studio | Read an approved wording | GET `/store/legal/wordings/:key` | JWT+Org | `design:view` | key | newest approved `{id,key,version,languageTag,text,status}` | `get_approved_legal_wording()` | drafts and retired versions never returned; none approved 404 |
| 112 | studio | Add a legal wording version | POST `/platform/legal/wordings` | JWT + Platform Admin | any Platform Admin | `{key, languageTag, text, status?: draft\|approved}` | wording (201) | `platform_create_legal_wording()` | server assigns the next version; approved rows are immutable (only retire) |
| 113 | studio | Record a legal approval | POST `/platform/legal/approvals` | JWT + Platform Admin | any Platform Admin | `{featureKey, wordingKey, wordingVersion, approverRef, approvedAt, release}` | approval (201) | `platform_record_feature_approval()` | wording must be approved (400 `WORDING_NOT_APPROVED`); append-only; nothing is ever seeded |
| 114 | studio | Record an attestation | POST `/store/attestations` | JWT+Org | `design:attest` (capability; Owner implicit) | `{type: badge_upload\|review_import, wordingKey, wordingVersion, assetId?, importId?, context?}` | attestation (201) | `attestations` (RLS insert policy), `resolve_approved_legal_wording()` | exact wording version pinned; unknown/unapproved/retired wording 400; append-only |
| 115 | studio | Ask to upload a Studio image | POST `/store/media-assets/upload-requests` | JWT+Org | `design:edit` | `{kind: badge_image, mimeType: jpeg\|png\|webp, sizeBytes<=5 MiB, width, height<=8192, altText?}` | `{id, path, token, signedUrl}` (201) | `media_assets` (RLS), Storage | SVG and other types 400; path `{tenant}/{uuid}.{ext}` chosen by the server; any client path field 400 |
| 116 | studio | Finish a Studio image upload | POST `/store/media-assets/:id/finalize` | JWT+Org | `design:edit` | `{attestationId?}` | media asset | `media_assets` (RLS), Storage | type and size re-read from Storage (mismatch 400, object removed); attestation must be this file's, the same person's; linked once (409); repeat is safe |
| 117 | studio | Check my design before publishing | POST `/store/studio/readiness` | JWT+Org | `design:view` | `{templateId?}` | `{issues[{key,ruleId,severity,message,messageKey,target{documentId,nodeId},fixAction,controlPath}], counts, canPublish, evaluatedAt, enforced}` | `templates` (RLS), `studio_rollout_status()`, `is_feature_approved()` | read-only; rule registry in `src/modules/studio/readiness`; blockers first. When Studio is ON for the store, `POST /store/theme/publish` and `POST /store/templates/:id/publish` rerun the rules inside the publish transaction before any write: blockers refused (400 `READINESS_BLOCKED`, no override), unacknowledged warnings refused (400 `READINESS_ACKNOWLEDGEMENT_REQUIRED`; send `acknowledgedWarnings: string[]` of issue keys), and one append-only `studio_publishes` row (publisher, items, acknowledgements, readiness summary, schema version) is written in the same transaction. Studio OFF: publish behaves exactly as before |

## Reviews, recommendations, Studio workflow and public additions (Store Forge Studio, Releases 2-4)

Routes added by the Studio releases after the foundation above. The request and response columns name the DTOs and results the live OpenAPI document describes; `test/swagger.e2e-spec.ts` compares this table with the registered routes in both directions.

| # | Module | Feature | Method + endpoint | Auth | Permission | Request | Response |
|---|---|---|---|---|---|---|---|
| 118 | recommendations | Read merchant-picked recommendations for a product | GET `/store/products/:productId/recommendations` | JWT+Org | `catalog:view` | productId | merchant-picked recommendations |
| 119 | recommendations | Set merchant-picked recommendations for a product | PUT `/store/products/:productId/recommendations` | JWT+Org | `catalog:manage` | `SetRecommendationsDto` (a product cannot recommend itself) | updated recommendations |
| 120 | reviews | List reviews | GET `/reviews` | JWT+Org | `catalog:view` | filters, `page, limit` | paginated reviews |
| 121 | reviews | Create a review | POST `/reviews` | JWT+Org | `catalog:manage` | `CreateReviewDto` | review |
| 122 | reviews | Review CSV import template | GET `/reviews/import-template` | JWT+Org | `catalog:view` | - | CSV header row |
| 123 | reviews | Import reviews | POST `/reviews/import` | JWT+Org | `catalog:manage` | `ReviewImportRequestDto`; validate-only mode checks every row without inserting; a real import needs an attestation id and is all-or-nothing | import result |
| 124 | reviews | Update a review | PATCH `/reviews/:id` | JWT+Org | `catalog:manage` | `UpdateReviewDto` | review |
| 125 | reviews | Delete a review | DELETE `/reviews/:id` | JWT+Org | `catalog:delete` | id | `{}` |
| 126 | reviews | Publish a review | POST `/reviews/:id/publish` | JWT+Org | `catalog:manage` | - (id only) | review |
| 127 | reviews | Unpublish a review | POST `/reviews/:id/unpublish` | JWT+Org | `catalog:manage` | - (id only) | review |
| 128 | studio | Read Studio settings | GET `/store/studio/settings` | JWT+Org | `design:view` | - | review disclosure wording and language |
| 129 | studio | Update Studio settings | PATCH `/store/studio/settings` | JWT+Org | `design:edit` | `UpdateStudioSettingsDto` | settings |
| 130 | studio | Web Vitals statistics | GET `/store/studio/speed` | JWT+Org | `design:view` | - | aggregated Web Vitals from real visitor sessions |
| 131 | studio | Mark drafts ready for review | POST `/store/studio/review-requests` | JWT+Org | `design:edit` | - (acts on the store's current drafts) | review request with its revision fingerprint |
| 132 | studio | Current review request | GET `/store/studio/review-requests/current` | JWT+Org | `design:view` | - | the pending review request, if any |
| 133 | studio | Unpublished draft changes | GET `/store/studio/changes` | JWT+Org | `design:view` | - | drafts compared with the published versions |
| 134 | studio | Change ledger | GET `/store/studio/ledger` | JWT+Org | `design:view` | - | recent ledger entries |
| 135 | studio | Discard draft changes | POST `/store/studio/discard` | JWT+Org | `design:edit` (and the discard capability) | `DiscardDraftDto` | template back at its published version |
| 136 | studio | List reusable sections | GET `/store/studio/reusable-sections` | JWT+Org | `design:view` | - | sections with usage counts and current versions |
| 137 | studio | Create a reusable section | POST `/store/studio/reusable-sections` | JWT+Org | `design:edit` | `CreateReusableSectionDto` | section and its first version (201) |
| 138 | studio | Read a reusable section | GET `/store/studio/reusable-sections/:id` | JWT+Org | `design:view` | id | section with its current version |
| 139 | studio | Update a reusable section | PUT `/store/studio/reusable-sections/:id` | JWT+Org | `design:edit` | `UpdateReusableSectionDto` | section; may add a new immutable version |
| 140 | studio | Archive a reusable section | DELETE `/store/studio/reusable-sections/:id` | JWT+Org | `design:edit` | id | `{}`; 409 while an active template uses it |
| 141 | studio | Reusable section versions | GET `/store/studio/reusable-sections/:id/versions` | JWT+Org | `design:view` | id | full version history |
| 142 | studio | Restore a section version | POST `/store/studio/reusable-sections/:id/restore` | JWT+Org | `design:edit` | `RestoreReusableSectionVersionDto` | a new version carrying the restored content |
| 143 | public | Published reviews for a product | GET `/public/storefronts/:slug/products/:productSlug/reviews` | Public | - | slug, productSlug | published reviews and disclosure wording; unpublished reviews are never returned |
| 144 | public | Product recommendations | GET `/public/storefronts/:slug/recommendations` | Public | - | slug, source (related, merchant_picked, collection, newest, recently_viewed) | recommended products |
| 145 | public | Record a Web Vitals sample | POST `/public/vitals` | Public | - | `RecordWebVitalsDto` (LCP, CLS, INP, TTFB, FCP) | daily histogram sample recorded |
| 146 | public | Published landing page | GET `/public/storefronts/:slug/landing-pages/:pageSlug` | Public | - | slug, pageSlug | section-based landing page document; 404 when unpublished |

## Payments (Owner-only Razorpay configuration)

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 147 | payments | See the Razorpay settings | GET `/payments/razorpay` | `payments:manage` | org (header required) | - | `{ configured }` plus, when saved, masked Key ID, mode, webhookSecretConfigured, webhookSecretUpdatedAt, updatedAt, updatedByName | `tenant_razorpay_config` (RLS, column grants) | Owner only; never returns the secret; 400 `ORGANIZATION_REQUIRED` without `X-Organization-Id` |
| 148 | payments | Save the Razorpay settings | PUT `/payments/razorpay` | `payments:manage` | org (header required) | keyId, keySecret (required); webhookSecret (optional, kept when omitted) | same safe status | `tenant_razorpay_config` (RLS, column grants) | encrypts (AES-256-GCM) before storing; one atomic upsert; 503 `PAYMENTS_UNAVAILABLE` and nothing written when the key is unusable; throttled |
| 149 | payments | Remove the Razorpay settings | DELETE `/payments/razorpay` | `payments:manage` | org (header required) | - | `{ configured: false }` | `tenant_razorpay_config` (RLS, column grants) | hard delete, idempotent, needs no key; throttled |

## Orders and checkout

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 150 | checkout | Place an order | POST `/public/stores/:slug/orders` | - | Public (throttled, `Idempotency-Key` header required) | `PlaceOrderDto` (lines, customer, shipping/billing address, payment method) | the order with totals and a one-time `accessToken` | `orders`, `order_items`, `order_addresses`, `order_status_history`, `inventory_reservations`, `customers` (tenant-pinned checkout role) | prices and stock re-read and locked server-side; one transaction; 409 `CHECKOUT_ISSUES` lists out-of-stock, unavailable and price-changed items; 409 `PAYMENT_METHOD_UNAVAILABLE` until payments are set up |
| 151 | checkout | View your order | GET `/public/stores/:slug/orders/:orderNumber` | - | Public (`X-Order-Token`) | slug, orderNumber | the shopper's order | `orders` and children (tenant-pinned) | wrong token and unknown order are both 404 |
| 152 | checkout | Cancel your order | POST `/public/stores/:slug/orders/:orderNumber/cancel` | - | Public (`X-Order-Token`) | slug, orderNumber | the cancelled order | `orders`, `inventory_reservations`, `inventory_adjustments` | only before processing; paid orders need a refund first (409 `REFUND_REQUIRED`); stock returns |
| 153 | orders | List orders | GET `/orders` | `orders:view` | JWT+Org | page, limit, search, status, paymentStatus, paymentMethod | page of order summaries | `orders` (RLS) | newest first |
| 154 | orders | View one order | GET `/orders/:id` | `orders:view` | JWT+Org | id | items, amounts, addresses, status history, next valid statuses | `orders` and children (RLS) | 404 across organizations |
| 155 | orders | Move an order to its next status | POST `/orders/:id/status` | `orders:manage` | JWT+Org | `UpdateOrderStatusDto` | the updated order | `orders`, `order_status_history` | state machine: invalid moves are 409 `ORDER_INVALID_TRANSITION`; throttled |
| 156 | orders | Cancel an order | POST `/orders/:id/cancel` | `orders:manage` | JWT+Org | `CancelOrderDto` | the cancelled order | `orders`, `inventory_reservations`, `inventory_adjustments` | releases holds or restocks sold units; paid orders need a refund first; throttled |

## Online payments and cash on delivery

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 157 | payments | Check the connection to Razorpay | POST `/payments/razorpay/verify` | `payments:manage` | org (header required) | - | Razorpay status incl. `verificationStatus` | `tenant_razorpay_config` (via `record_razorpay_verification`) | Owner only; calls Razorpay `GET /v1/orders?count=1` with the saved keys (creates nothing); a failed check switches payments off; 503 `PAYMENT_PROVIDER_UNAVAILABLE` leaves the state unchanged; throttled |
| 158 | payments | Turn Razorpay payments on or off | PUT `/payments/razorpay/enabled` | `payments:manage` | org (header required) | `SetRazorpayEnabledDto` | Razorpay status | `tenant_razorpay_config` (via `set_razorpay_enabled`) | on requires a successful check (409 `RAZORPAY_NOT_VERIFIED`); replacing the keys switches it off again; throttled |
| 159 | payments | See the cash on delivery settings | GET `/payments/cod` | `payments:manage` | org (header required) | - | `CodSettingsDto` | `tenant_cod_config` (RLS) | Owner only |
| 160 | payments | Save the cash on delivery settings | PUT `/payments/cod` | `payments:manage` | org (header required) | `SaveCodSettingsDto` | `CodSettingsDto` | `tenant_cod_config` (RLS) | enabled, min/max items subtotal, extra charge; max below min is rejected; throttled |
| 161 | orders | Mark cash on delivery as collected | POST `/orders/:id/cod/collect` | `orders:manage` | JWT+Org | id | the order | `orders`, `payment_transactions` | COD only; needs the order shipped or later; never "paid" before this; idempotent; throttled |
| 162 | checkout | Payment methods a store offers | GET `/public/stores/:slug/payment-methods` | - | Public | slug, subtotalMinor | `PaymentMethodOptionsDto` | `tenant_razorpay_config` (yes/no function only), `tenant_cod_config` | tells the checkout page what to show |
| 163 | checkout | Start (or retry) the online payment | POST `/public/stores/:slug/orders/:orderNumber/payments/razorpay` | - | Public (`X-Order-Token`, throttled) | slug, orderNumber | Razorpay Checkout session (`keyId`, `razorpayOrderId`, amount from the server) | `payment_transactions` | creates the Razorpay order for the server-computed amount; a retry reuses it; 409 when not payable, already paid or expired |
| 164 | checkout | Confirm an online payment | POST `/public/stores/:slug/orders/:orderNumber/payments/razorpay/verify` | - | Public (`X-Order-Token`, throttled) | `VerifyRazorpayPaymentDto` | the order | `payment_transactions`, `orders`, `inventory_*` | checks the HMAC signature with the tenant's secret AND asks Razorpay about the payment (order, amount, status); captures an authorised payment; only then marks paid and confirms; a lost reservation cancels the order and flags a refund; idempotent |
| 165 | checkout | Record a failed payment attempt | POST `/public/stores/:slug/orders/:orderNumber/payments/razorpay/failed` | - | Public (`X-Order-Token`, throttled) | `ReportRazorpayFailureDto` | the order | `payment_transactions` | the failure is read from Razorpay, not taken from the browser; the order stays open for a retry |

## Transactions, refunds and Razorpay webhooks

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 166 | payments | Payment transaction history | GET `/payments/transactions` | `payments:manage` | org (header required) | page, limit, search, status, provider, method, refundStatus, from, to | page of transactions with refund totals | `payment_transactions`, `refunds` (RLS) | Owner only; search by order number, internal id, Razorpay ids |
| 167 | payments | View one transaction | GET `/payments/transactions/:id` | `payments:manage` | org (header required) | id | transaction, failure reason, refunds, webhook timeline | `payment_transactions`, `refunds`, `payment_webhook_events` (RLS) | 404 across organizations |
| 168 | payments | Refund a payment (full or partial) | POST `/payments/transactions/:id/refunds` | `payments:manage` | org (header required, `Idempotency-Key` header required) | `CreateRefundDto` | the refund | `refunds`, `payment_transactions`, `orders` | refund row saved under a lock before Razorpay is called; total can never exceed the amount received (409 `REFUND_EXCEEDS_PAYMENT`); an unclear failure is resolved by Razorpay receipt lookup, never a second refund; COD is refused (409 `COD_REFUND_MANUAL`); throttled |
| 169 | payments | Refund history | GET `/payments/refunds` | `payments:manage` | org (header required) | page, limit, status | page of refunds | `refunds` (RLS) | includes refunds made in the Razorpay dashboard |
| 170 | payments | Check a refund with Razorpay | POST `/payments/refunds/:id/sync` | `payments:manage` | org (header required) | id | the refund | `refunds` | looks the refund up (or finishes sending it); idempotent; throttled |
| 171 | webhooks | Receive Razorpay webhooks | POST `/webhooks/razorpay/:tenantPublicId` | - | Public (HMAC signature of the raw body with the organization's webhook secret) | Razorpay event | `{ result: processed \| ignored \| duplicate }` | `payment_webhook_events`, `payment_transactions`, `refunds`, `orders` | 401 for any signature problem (same answer for unknown organization); one stored row per event id so redelivery is harmless; amounts and orders are checked against our records; processing errors answer 500 so Razorpay retries |

## Shipping carriers (Owner-only)

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 172 | shipping | List carriers and connection status | GET `/shipping/carriers` | `carriers:manage` | org (header required) | - | every supported carrier: capabilities, integration status, settings it needs, this organization's connection | `tenant_carrier_connections` (RLS, column grants) | Owner only; secrets never returned, only which are saved |
| 173 | shipping | Connect a carrier or update its settings | PUT `/shipping/carriers/:code` | `carriers:manage` | org (header required) | `SaveCarrierDto` (`values` by key) | the carrier | `tenant_carrier_connections`, `carrier_connection_events` | secrets encrypted (AES-256-GCM, tenant-bound) before storing; a secret left out is kept; any change turns the carrier off until re-checked; per-field errors 400 `CARRIER_SETTINGS_INVALID`; nothing sent to the carrier; throttled |
| 174 | shipping | Try settings without saving | POST `/shipping/carriers/:code/test` | `carriers:manage` | org (header required) | `SaveCarrierDto` | `{ valid, message }` | - (reads the saved connection to fill gaps) | asks the carrier; stores nothing; 503 `CARRIER_UNAVAILABLE` on an outage; throttled |
| 175 | shipping | Check the saved connection | POST `/shipping/carriers/:code/verify` | `carriers:manage` | org (header required) | - | the carrier | `tenant_carrier_connections` (via `record_carrier_verification`) | records the result; a failed check turns the carrier off; an outage changes nothing; throttled |
| 176 | shipping | Turn a carrier on or off | PUT `/shipping/carriers/:code/enabled` | `carriers:manage` | org (header required) | `SetCarrierEnabledDto` | the carrier | `tenant_carrier_connections` (via `set_carrier_enabled`) | on needs a successful check (409 `CARRIER_NOT_VERIFIED`) and, for an `unverified` integration, an explicit acknowledgement (409 `INTEGRATION_UNVERIFIED`); off clears the default; throttled |
| 177 | shipping | Make a carrier the default | PUT `/shipping/carriers/:code/default` | `carriers:manage` | org (header required) | `SetCarrierDefaultDto` | the carrier | `tenant_carrier_connections` (via `set_carrier_default`) | must be on (409 `CARRIER_NOT_ENABLED`); one default per organization; throttled |
| 178 | shipping | Disconnect a carrier | DELETE `/shipping/carriers/:code` | `carriers:manage` | org (header required) | - | `null` | `tenant_carrier_connections`, `carrier_connection_events` | deletes the credentials for good; 404 if not connected; throttled |
| 179 | shipping | Carrier change history | GET `/shipping/carrier-events` | `carriers:manage` | org (header required) | page, limit, action | page of events | `carrier_connection_events` (RLS) | who, what, when; names of settings only, never values; append-only |
| 180 | shipping | See how carriers are chosen | GET `/shipping/preferences` | `carriers:manage` | org (header required) | - | mode, strategy, active carrier count, default carrier | `tenant_shipping_preferences`, `tenant_carrier_connections` (RLS) | defaults: manual, lowest cost |
| 181 | shipping | Choose how carriers are selected | PUT `/shipping/preferences` | `carriers:manage` | org (header required) | `SavePreferencesDto` | preferences | `tenant_shipping_preferences` (RLS) | manual or automatic; strategy lowest_cost / fastest / preferred; throttled |

## Shipping zones, methods, rates and delivery options

| # | Module | Feature | Method + endpoint | Permission | Auth | Request | Response | DB | Logic |
|---|---|---|---|---|---|---|---|---|---|
| 182 | shipping | List shipping zones | GET `/shipping/zones` | `shipping:view` | org (header required) | - | zones with an area summary and method count | `shipping_zones`, `shipping_zone_areas` (RLS) | readable with read access to the store settings |
| 183 | shipping | View one zone | GET `/shipping/zones/:id` | `shipping:view` | org (header required) | id | the zone with everything it covers | `shipping_zones`, `shipping_zone_areas` | 404 across organizations |
| 184 | shipping | Create a zone | POST `/shipping/zones` | `shipping:manage` | org (header required) | `SaveZoneDto` (country, states, cities, PIN codes, PIN ranges) | the zone (201) | `shipping_zones`, `shipping_zone_areas` | an address belongs to the zone of its most specific area; the same area cannot be in two zones and PIN ranges cannot overlap (409 `ZONE_CONFLICT` naming the clash); edits serialised per organization; throttled |
| 185 | shipping | Change a zone | PUT `/shipping/zones/:id` | `shipping:manage` | org (header required) | `SaveZoneDto` | the zone | `shipping_zones`, `shipping_zone_areas` | replaces areas atomically; a refused update changes nothing; a zone switched off means "not served" |
| 186 | shipping | Delete a zone | DELETE `/shipping/zones/:id` | `shipping:manage` | org (header required) | id | `null` | `shipping_zones` (cascades) | removes its areas, methods and rate bands; placed orders keep their own copy |
| 187 | shipping | List shipping methods and rates | GET `/shipping/methods` | `shipping:view` | org (header required) | zoneId | methods with their rate bands | `shipping_methods`, `shipping_rate_tiers` | |
| 188 | shipping | View one method | GET `/shipping/methods/:id` | `shipping:view` | org (header required) | id | the method | `shipping_methods`, `shipping_rate_tiers` | |
| 189 | shipping | Create a method | POST `/shipping/methods` | `shipping:manage` | org (header required) | `SaveMethodDto` | the method (201) | `shipping_methods`, `shipping_rate_tiers` | flat / free / weight / order value / carrier; free-shipping threshold, value and weight limits, delivery time, COD allowed; rate bands must start at 0, join up and end open; carrier methods only name a carrier that quotes prices (400 `METHOD_INVALID` per field) |
| 190 | shipping | Change a method | PUT `/shipping/methods/:id` | `shipping:manage` | org (header required) | `SaveMethodDto` | the method | `shipping_methods`, `shipping_rate_tiers` | replaces the rate bands; stays in its zone |
| 191 | shipping | Delete a method | DELETE `/shipping/methods/:id` | `shipping:manage` | org (header required) | id | `null` | `shipping_methods` (cascades) | |
| 192 | shipping | See the pickup address | GET `/shipping/origin` | `shipping:view` | org (header required) | - | the address, `configured` | `tenant_shipping_origin` | |
| 193 | shipping | Save the pickup address | PUT `/shipping/origin` | `shipping:manage` | org (header required) | `SaveOriginDto` | the address | `tenant_shipping_origin` | where carrier prices and shipments start |
| 194 | shipping | Preview delivery options | POST `/shipping/preview` | `shipping:view` | org (header required) | `PreviewDto` (address, subtotal, weight) | zone, options with price and days, what was left out and why | read-only | exactly what a shopper would be offered; carrier-priced methods call the carriers; throttled |
| 195 | shipping | Compare connected carriers | POST `/shipping/carrier-quotes` | `carriers:manage` | org (header required) | `CarrierComparisonDto` | candidates, skipped carriers with reasons, the choice the settings make | read-only | only carriers that confirmed delivery are candidates; needs the pickup address (400 `ORIGIN_MISSING`); throttled |
| 196 | checkout | Delivery options for a cart and address | POST `/public/stores/:slug/shipping/options` | - | Public (throttled) | address, cart lines, payment method | zone, options (price from the server, days, COD allowed) | `shipping_*` tables, products (read-only, pinned tenant) | cart priced and weighed by the server; `configured: false` when the store has no zones; 409 `CHECKOUT_ISSUES` like placing an order; internal carrier figures are not returned |
| 197 | shipments | List shipments | GET `/shipments` | `orders:view` | org (header required) | page, status, providerCode | shipments | `shipments`, `orders` (RLS) | every parcel booked with the organization's own carriers |
| 198 | shipments | List an order's shipments | GET `/orders/:orderId/shipments` | `orders:view` | org (header required) | orderId | shipments, oldest first | `shipments` | an order may have several when sent in parts |
| 199 | shipments | Create a shipment | POST `/orders/:orderId/shipments` | `orders:manage` | org (header required) | `CreateShipmentDto` (items, carrier, weight, sizes) | the shipment with items and history (201) | `shipments`, `shipment_items`, `shipment_events`, `orders`, `order_status_history` | order must be confirmed and paid (or COD); saved as `creating` BEFORE the carrier is called, carrier called with no transaction open, result recorded after; carrier = named, else the one priced at checkout, else the settings' choice; COD ships in one full parcel; 503 `SHIPMENT_PENDING` keeps the saved shipment for a retry; moves the order to ready to ship; throttled |
| 200 | shipments | View one shipment | GET `/shipments/:id` | `orders:view` | org (header required) | id | shipment with items and tracking history | `shipments`, `shipment_items`, `shipment_events` | 404 across organizations |
| 201 | shipments | Retry booking | POST `/shipments/:id/retry` | `orders:manage` | org (header required) | id | the shipment | `shipments` | resumes at the carrier where it got to (never books twice); throttled |
| 202 | shipments | Cancel a shipment | POST `/shipments/:id/cancel` | `orders:manage` | org (header required) | id | the shipment | `shipments`, `orders` | only before pickup; a cancellation the carrier did not accept is never recorded; frees the items; throttled |
| 203 | shipments | Refresh tracking | POST `/shipments/:id/refresh` | `orders:manage` | org (header required) | id | the shipment | `shipments`, `shipment_events`, `orders` | asks the carrier now; records each update once; moves the order forward only; throttled |
| 204 | shipments | Label status | GET `/shipments/:id/label` | `orders:view` | org (header required) | id | `available`, `url`, `stored` | `shipments` | a link held by the carrier and/or a stored PDF |
| 205 | shipments | Generate the label | POST `/shipments/:id/label` | `orders:manage` | org (header required) | id | label status | `shipments`, `shipment_labels` | asks the carrier; stores only a real PDF (<= 5 MB) or an https link; 503 `LABEL_NOT_READY`; throttled |
| 206 | shipments | Download the label PDF | GET `/shipments/:id/label/file` | `orders:view` | org (header required) | id | the PDF file (not enveloped) | `shipment_labels` | private, no-store; 404 `LABEL_NOT_FOUND` |
| 207 | webhooks | Receive carrier tracking webhooks | POST `/webhooks/carriers/:providerCode` | - | Public (throttled) | the carrier's own body | `null` (always 200) | `shipments` (read via a narrow function), then as a refresh | body is only used to find waybill numbers and is never believed: the carrier is asked directly with the owning shop's own credentials; at most one lookup per parcel per 20 s |
| 208 | tax | View GST settings | GET `/tax/settings` | `tax:view` | org (header required) | - | GSTIN, rates, `configured` | `tenant_tax_settings` (RLS) | no tax is charged until GST is turned on |
| 209 | tax | Save GST settings | PUT `/tax/settings` | `tax:manage` | org (header required) | `SaveTaxSettingsDto` | the settings | `tenant_tax_settings` | GSTIN checked (shape + check character) and its state taken from it; turning GST on needs a GSTIN; applies to orders placed from now on; throttled |
| 210 | tax | GST report | GET `/tax/report` | `tax:report` | org (header required) | from, to (YYYY-MM-DD, at most 366 days) | totals and rows by rate: taxable, CGST, SGST, IGST | `order_tax_lines`, `orders` (RLS) | reads what each order saved; cancelled, failed and unpaid orders excluded; India dates |
| 211 | checkout | Price a cart as checkout would | POST `/public/stores/:slug/checkout/quote` | - | Public (throttled) | address, cart lines, payment method, delivery option, optional `discountCode` | subtotal, discount, delivery, COD charge, GST line by line, total | products, shipping and tax tables (read-only, pinned tenant) | same code as placing an order (shipping option price, COD charge, discount, tax); 409 `CHECKOUT_ISSUES`, 409 `DISCOUNT_INVALID`; not a promise, the order is priced again |
| 212 | marketing | List discount codes | GET `/marketing/discounts` | `marketing:view` | org | page, limit, search, status, campaignId, sortBy | codes with status and performance | `discount_codes`, `discount_redemptions`, `orders` (RLS) | performance is computed from the orders that used the code; cancelled and failed orders do not count as use |
| 213 | marketing | View one discount code | GET `/marketing/discounts/:id` | `marketing:view` | org | id | the code, its performance, its products and collections | `discount_codes`, `discount_code_targets` | 404 across organizations |
| 214 | marketing | Create a discount code | POST `/marketing/discounts` | `marketing:manage` | org | `CreateDiscountDto` | the code (201) | `discount_codes`, `discount_code_targets` | code upper-cased and unique per organization (409 `DISCOUNT_CODE_TAKEN`); percentage in basis points, optional cap; fixed amount in paise; a scoped code needs targets from this organization; throttled |
| 215 | marketing | Change or switch a discount code | PATCH `/marketing/discounts/:id` | `marketing:manage` | org | `UpdateDiscountDto` | the code | `discount_codes`, `discount_code_targets` | the code itself never changes; `isActive:false` applies at once; `redemption_count` cannot be written by the dashboard; throttled |
| 216 | marketing | Delete a discount code | DELETE `/marketing/discounts/:id` | `marketing:manage` | org | id | `null` | `discount_codes` | 409 `DISCOUNT_HAS_USE` once an order has used it (disable instead); throttled |
| 217 | marketing | List campaigns | GET `/marketing/campaigns` | `marketing:view` | org | page, limit, search, status, sortBy | campaigns with phase and performance | `promotional_campaigns`, `discount_codes`, `discount_redemptions`, `orders` | phase: draft, scheduled, live, paused, ended; performance is the sum over the campaign's codes |
| 218 | marketing | View one campaign | GET `/marketing/campaigns/:id` | `marketing:view` | org | id | campaign, products, collections, codes | `promotional_campaigns`, `campaign_targets` | 404 across organizations |
| 219 | marketing | Create a campaign | POST `/marketing/campaigns` | `marketing:manage` | org | `CreateCampaignDto` | the campaign (201), as a draft | `promotional_campaigns`, `campaign_targets`, `discount_codes` | name unique per organization (409 `CAMPAIGN_NAME_TAKEN`); end after start; nothing is ever sent to customers; throttled |
| 220 | marketing | Change a campaign | PATCH `/marketing/campaigns/:id` | `marketing:manage` | org | `UpdateCampaignDto` | the campaign | `promotional_campaigns`, `campaign_targets`, `discount_codes` | a list that is sent replaces the stored one; a completed campaign is read-only (409); throttled |
| 221 | marketing | Activate, pause or complete a campaign | POST `/marketing/campaigns/:id/status` | `marketing:manage` | org | `CampaignStatusDto` | the campaign | `promotional_campaigns` | draft to active, active and paused both ways, either to completed; completed is final (409 `CAMPAIGN_STATUS_INVALID`); cannot activate past the end date; its codes work only while it is live; throttled |
| 222 | marketing | Delete a campaign | DELETE `/marketing/campaigns/:id` | `marketing:manage` | org | id | `null` | `promotional_campaigns` | its codes are kept and leave the campaign; throttled |
| 223 | checkout | Check a discount code against a cart | POST `/public/stores/:slug/discounts/validate` | - | Public (throttled, 30 a minute) | code, cart lines, optional email | `valid`, amount, eligible subtotal, or the reason | catalog, `discount_codes`, `discount_code_targets`, `collection_products` (read-only, pinned tenant) | a preview with the exact rules the order uses (active, dates, campaign, usage and per-customer limits, minimum, eligible items); an unknown and a disabled code look the same; the order checks again under a lock |
| 224 | marketing | List abandoned carts | GET `/marketing/abandoned-carts` | `marketing:view` | org | page, limit, search, status, from, to, sortBy | carts with status, value, last activity, abandonment date | `abandoned_carts` (column grants hide the lookup hashes), `orders` | abandonment is worked out when read: idle for the threshold (60 min default); expired after the recovery window (14 days default) |
| 225 | marketing | Abandoned cart totals | GET `/marketing/abandoned-carts/summary` | `marketing:view` | org | from, to (default last 30 days, store time zone) | abandoned and recovered counts and value, recovery rate, active | `abandoned_carts`, `orders` | recovered value is what the recovered orders came to; rate = recovered / (abandoned + recovered) |
| 226 | marketing | View abandoned cart settings | GET `/marketing/abandoned-carts/settings` | `marketing:view` | org | - | threshold minutes, recovery link days, `configured` | `tenant_marketing_settings` (RLS) | defaults apply until saved |
| 227 | marketing | Save abandoned cart settings | PUT `/marketing/abandoned-carts/settings` | `store:manage` | org | `SaveAbandonedCartSettingsDto` | the settings | `tenant_marketing_settings` | 15 minutes to 7 days, 1 to 90 days; applies to carts already waiting; throttled |
| 228 | marketing | View one abandoned cart | GET `/marketing/abandoned-carts/:id` | `marketing:view` | org | id | the cart, its items and `recoveryPath` | `abandoned_carts` | the recovery token is recomputed (HMAC under a key derived from the server master key), never stored; null once recovered or expired; 404 across organizations |
| 229 | marketing | Erase an abandoned cart | DELETE `/marketing/abandoned-carts/:id` | `marketing:manage` | org | id | `null` | `delete_abandoned_cart()` (re-checks access) | removes the customer details with it; its link stops working; throttled |
| 230 | checkout | Save a cart for recovery | POST `/public/stores/:slug/cart/checkpoint` | - | Public (throttled) | cart id from the browser, cart lines, customer email (+ name, phone), `marketingConsent` | `saved` | `checkpoint_abandoned_cart()` (pinned tenant) | prices are the server's own; only hashes of the browser cart id and of the link token are stored; one row per browser cart; 503 `CART_RECOVERY_UNAVAILABLE` without the server key (the storefront ignores it); throttled; nothing is ever sent to the shopper |
| 231 | checkout | Open a cart recovery link | GET `/public/stores/:slug/cart/recovery/:token` | - | Public (throttled) | token | the lines that can still be bought, priced now, and the issues | `open_cart_recovery()` (pinned tenant) | wrong, foreign, expired, spent and erased links all answer 404 `RECOVERY_LINK_INVALID`; counts the click; throttled |
| 232 | analytics | Sales overview and trends | GET `/analytics/sales` | `marketing:view` | org | from, to (YYYY-MM-DD, default last 30 days), interval day|week|month | totals, change from the previous period, series with no gaps | `orders`, `order_refund_totals()` | counted orders = confirmed..delivered placed in the period (store time zone); gross - discounts - refunds = net sales; total sales = what customers were charged; net revenue = total sales - refunds; a refund belongs to its order's period (no double counting); day ranges at most 366 days, week/month 3 years |
| 233 | analytics | Revenue report (daily, weekly, monthly) | GET `/analytics/revenue` | `marketing:view` | org | from, to, interval | the same report as `/analytics/sales` | `orders`, `order_refund_totals()` | one engine behind both routes, so they always agree; weeks start Monday |
| 234 | analytics | Product performance | GET `/analytics/products` | `marketing:view` | org | from, to, page, limit, search, sortBy units|revenue|orders, sortOrder | units, item revenue, orders containing, per product | `order_items`, `orders`, `products` | desc = best sellers, asc = worst (active products nobody bought included); variants added together; conversion is null: product views are not tracked |
| 235 | analytics | Customer analytics | GET `/analytics/customers` | `customers:view` | org | from, to | totals, new, buyers, first-time, returning, repeat rate, average spend | `customers`, `orders` | returning = bought before the period began; repeat rate is all-time; guest orders without a customer record are not included |
| 236 | analytics | Top customers | GET `/analytics/customers/top` | `customers:view` | org | from, to, page, limit, search, sortBy revenue|orders | customers ranked by what they were charged | `customers`, `orders` | counted orders only |
| 237 | analytics | Customer purchase history | GET `/analytics/customers/:id/history` | `customers:view` | org | id, page, limit | lifetime totals and the customer's orders, newest first | `customers`, `orders`, `order_items` | each order marked `countsAsSale`; 404 across organizations |
| 238 | integrations | List integrations | GET `/integrations` | `integrations:view` | org (header required) | - | every supported integration with configured / validated / enabled state, public identifiers, last change | `marketing_integrations` (secret columns are not granted) | header required; private credentials are never part of a response |
| 239 | integrations | View one integration | GET `/integrations/:provider` | `integrations:view` | org (header required) | provider | the integration, its form fields and its 20 latest audit entries | `marketing_integrations`, `marketing_integration_events` | 404 `INTEGRATION_NOT_FOUND`; the audit never holds a value or a secret |
| 240 | integrations | Save and validate an integration | PUT `/integrations/:provider` | `integrations:manage` | org (header required) | `SaveIntegrationDto` (`config`) | the integration | `marketing_integrations`, `marketing_integration_events` | the provider's own rules (GA4: `G-` + 10 capitals/digits); a changed value switches it off until enabled again (trigger); unchanged = no audit entry; throttled |
| 241 | integrations | Switch an integration on | POST `/integrations/:provider/enable` | `integrations:manage` | org (header required) | provider | the integration | `set_marketing_integration_enabled()` | only a validated configuration (409 `INTEGRATION_NOT_VALID`); audited; throttled |
| 242 | integrations | Switch an integration off | POST `/integrations/:provider/disable` | `integrations:manage` | org (header required) | provider | the integration | `set_marketing_integration_enabled()` | audited; storefronts stop loading it on their next request; throttled |
| 243 | integrations | Test an integration | POST `/integrations/:provider/test` | `integrations:manage` | org (header required) | provider | `ok`, the checks, a note on what the test cannot prove | `marketing_integrations`, `marketing_integration_events` | contacts only the provider's own host with a format-checked ID; a failure is reported and audited but never switches a working integration off; throttled (10 a minute) |
| 244 | integrations | Remove an integration | DELETE `/integrations/:provider` | `integrations:manage` | org (header required) | provider | `null` | `marketing_integrations` | the audit history stays; audited; throttled |
| 245 | integrations | Which tracking a storefront may load | GET `/public/stores/:slug/tracking` | - | Public (throttled) | - | enabled and validated integrations with their public identifiers, `consentRequired: true` | `public_tracking_config()` (pinned tenant) | a store only ever receives its own; no secret column is read; cacheable for a minute; the storefront must load nothing until the shopper agrees |
