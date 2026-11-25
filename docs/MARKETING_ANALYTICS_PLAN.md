# Marketing & Analytics: findings and implementation plan

## 1. Architecture findings

**Two repositories.** `store-forge-api` (NestJS 12, this repo) owns the schema, migrations and all business logic. `store-forge` (Next.js 16, branch `feat/marketing_analysis`) calls it through `lib/api/client.ts` + `lib/api/endpoints/*` from server code (`services/*.ts`, server actions). Its `AGENTS.md` says Next 16 differs from common knowledge: read `node_modules/next/dist/docs/` before writing frontend code.

**Tenancy.** Postgres RLS is the isolation boundary. Dashboard routes use `@OrgScoped()` and `DatabaseService.withUser(userId, tx => ...)` (transaction, verified JWT claims, `SET LOCAL ROLE authenticated`). The tenant comes from the verified membership (`CurrentOrg`), never from the body. Public storefront routes (`/public/stores/:slug/...`, `@Public()`) resolve the tenant from the slug and run through the tenant-pinned `storeforge_checkout` role (`pinned_tenant_id()`).

**Authorization.** `PERMISSIONS` in `common/constants/permissions.ts` maps a permission name to `{module, need}` or owner-only. Modules: products, orders, customers, settings, design. The database repeats it with `has_module_access()` / `has_tenant_role()`.

**Secrets.** `payments/credentials-crypto.ts` is AES-256-GCM with the tenant id as AAD. Ciphertext columns are not readable by `authenticated`. They are read only through `SECURITY DEFINER` functions granted to the pinned checkout role. Connection changes are logged in an append-only `*_events` table (see `0049_carrier_connections.sql`). I reuse this pattern as is.

**Orders and checkout.** `orders.discount_minor` already exists and checkout already calls `CheckoutAdjuster.adjust()`, which returns `discountMinor: 0` today (`shipping-adjuster.ts`, `public-quote.controller.ts`). Tax is computed after the discount. Discounts therefore plug into one existing seam. No checkout rewrite is needed. Refunds live in `refunds` (`payments.ts`, `refund-accounting.ts`). Revenue statuses are `REVENUE_ORDER_STATUSES`.

**Carts are client-side only** (`store-forge/lib/cart/cart.ts`). There is no server cart table, so abandoned-cart tracking needs a new public "cart checkpoint" write. It happens once the shopper gives an email at checkout.

**Existing analytics.** `modules/analytics` (`GET /analytics`, 7/30/90 days, zero-filled days, best sellers) backs the dashboard home. It is not touched. New reporting goes in a new module.

**Migrations.** Hand-written SQL in `src/database/migrations` (next is `0053`), registered in `meta/_journal.json`, with RLS, explicit GRANTs and a `schema/*.ts` Drizzle model that `db:verify-schema` compares with the database.

## 2. Decisions (deviations from the brief, with reasons)

| Topic | Decision | Why |
|---|---|---|
| Permissions | No new RLS module. `marketing:view` = orders read, `marketing:manage` = orders write; `integrations:view/manage` = settings read/write | Adding a module means changing `has_module_access`, the member-permission UI and every policy. The existing levels already match who should see sales data and who edits store settings |
| GA4 / Pixel IDs | Stored as plain `config` (they are public, in every page's HTML) | Encrypting them adds nothing. The table still has the encrypted-secret columns (nullable) for the future Conversions API / Measurement Protocol API secret, so nothing is rewritten later |
| `analytics_events` table | **Not created** | Browser events go straight to Google/Meta. Purchase dedupe uses the order id as `transaction_id` / `eventID` plus a per-order guard in the browser, so no server event store is required. Product conversion data is therefore reported as "not available", not invented |
| Discount stacking | One code per order | Simplest correct rule; avoids ambiguous max-discount and per-line allocation |
| Discount scope | Percentage/fixed applies to eligible line subtotal (all, selected products, selected collections). Shipping and tax are never discounted. Tax is computed on the discounted amount through the existing tax seam | Matches how GST is computed today |

## 3. Money definitions (used by every report)

- **Gross sales** = sum of `orders.subtotal_minor` for revenue-status orders (item value before discounts).
- **Discounts** = sum of `orders.discount_minor` on the same orders.
- **Refunds** = sum of succeeded `refunds.amount` for those orders, counted in the period the refund happened.
- **Net sales** = gross sales − discounts − refunds. Shipping, COD fee and tax are excluded, because they are not the merchant's product revenue.
- **Total collected** = sum of `orders.total_minor` (shown separately).
- An order is counted once, by `placed_at`. Cancelled, failed and unpaid online orders are excluded exactly like the existing analytics module.

## 4. Database (migration 0053, then 0054+ per phase)

| Table | Purpose | Key constraints |
|---|---|---|
| `promotional_campaigns` | name, description, status (draft/active/paused/completed), start/end, `channels` jsonb (future email/SMS) | unique(tenant, lower(name)), end > start |
| `campaign_targets` | product / collection scope of a campaign | FK composite to tenant, one of product/collection |
| `discount_codes` | percent (bps) or fixed (minor), min subtotal, max discount, window, usage limit, per-customer limit, scope, active, optional campaign, `redemption_count` | unique(tenant, upper(code)), value checks |
| `discount_code_targets` | products/collections the code applies to | as above |
| `discount_redemptions` | one row per order that used a code (audit, usage limits, performance) | unique(tenant, order) |
| `tenant_marketing_settings` | abandonment threshold, recovery link lifetime | one row per tenant |
| `abandoned_carts` | server checkpoint of a cart with email: items snapshot, value, status, recovery token hash, consent flag | unique(tenant, cart_token_hash), index(tenant, status, last_activity_at) |
| `marketing_integrations` | one row per tenant + provider (`ga4`, `meta_pixel`): enabled, public `config`, validation status, nullable encrypted secret | unique(tenant, provider), enabled requires validated |
| `marketing_integration_events` | append-only audit | like `carrier_connection_events` |

Every row has `tenant_id`, RLS enabled, no default grants, `session_user <> 'authenticator'` on every policy, and composite FKs `(tenant_id, id)` where children reference parents.

## 5. Backend modules and endpoints (`/api/v1`)

- `marketing/discounts` (CRUD, enable/disable, performance, `POST validate` for dashboard preview) and public `POST public/stores/:slug/discounts/validate` (cart quote). The checkout itself re-validates and records the redemption inside the order transaction.
- `marketing/campaigns` (CRUD, `POST :id/status`, performance).
- `marketing/abandoned-carts` (list, detail, settings) and public `POST public/stores/:slug/cart-checkpoint`, `GET public/stores/:slug/cart-recovery/:token`.
- `analytics/sales`, `analytics/revenue`, `analytics/products`, `analytics/customers` (+ `customers/:id/history`), all with `from`/`to` and pagination where lists.
- `marketing/integrations` (list, GET/PUT/DELETE per provider, `POST :provider/enable|disable|test`) and public `GET public/stores/:slug/tracking` (returns only enabled provider IDs, no secrets).

## 6. Frontend (store-forge)

Dashboard `marketing/{discounts,campaigns,abandoned-carts}`, `analytics/{sales,revenue,products,customers}` (extends the existing analytics page), `settings/integrations` with separate GA4 and Meta Pixel forms. Storefront gets a small `TrackingProvider` loaded in the `s/[slug]` layout: loads a provider script only when it is enabled **and** the shopper has consented, and exposes `track(event, payload)` used by product, cart, checkout and order pages. Tracking errors are caught and never reach checkout.

## 7. Status

All seven phases are done in both repositories (`store-forge-api` and `store-forge`). What differs from the plan above:

- Migrations `0053` to `0059` (tables, discount redemption functions, abandoned-cart functions, refund totals, public tracking config, cart retention, report functions). `analytics_events` was not needed, as planned.
- Reports use read-only database functions that check access once per call (migration `0059`) instead of row level security per row: measured about 10 to 40 times faster, and a member without the right access now gets a 403 instead of a report of zeros.
- Public order items carry `productSlug`, so purchase events name a product the same way as view and add-to-bag events.

## 8. Phases (as planned)

1. **Schema and foundations** (this change): migration 0053, Drizzle models, permissions, shared date-range and pagination helpers.
2. Discounts, campaigns, checkout integration.
3. Abandoned carts.
4. Analytics and reports.
5. GA4.
6. Meta Pixel.
7. Tests, security review, docs, full lint/type/test/build run.

Each phase ships its own tests and is committed separately. Phases 2 to 4 depend on 1; 5 and 6 depend on the integrations table and permissions from 1 and on the storefront `TrackingProvider` (built in 5, reused by 6).
