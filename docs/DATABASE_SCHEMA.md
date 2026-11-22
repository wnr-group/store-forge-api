# Database Schema

The database already exists and is **owned by the Next.js repo's migrations** (`drizzle/0000` - `0024`, applied to Supabase). This repo reads/writes it through Drizzle and **creates no tables and no migrations of its own** (see API_MIGRATION_PLAN.md > Migration status). The Drizzle definitions in `src/database/schema/` are a faithful port of `lib/db/schema/*` for the tables the API uses; they must not be pushed (`drizzle-kit push` is deliberately not configured).

`auth.users` is referenced but never redefined (a minimal `authUsers` reference table from `drizzle-orm/supabase` is used for FKs only).

## Tables used by the API

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `profiles` | App user data, `id` = auth user id | `full_name <= 120`; created by trigger |
| `tenants` | Organization | `slug` unique + pattern; `status active\|suspended`; `name` 2-80 |
| `memberships` | User <-> tenant | unique `(tenant_id,user_id)`; `role owner\|admin\|staff`; `status active\|disabled`; `permissions jsonb` validated by `is_valid_member_permissions`; **one owner per tenant** (partial unique index) |
| `stores` | Storefront | `slug` globally unique; unique `(tenant_id,id)`; `currency ^[A-Z]{3}$`; logo path must start `{tenant}/store/`; `status active\|inactive\|suspended` |
| `categories` | Catalog | unique `(tenant_id,slug)`; `parent_id` self-FK `set null`; `parent <> id` |
| `collections` | Catalog | unique `(tenant_id,slug)`; `status draft\|active`; image path `{tenant}/collections/{id}/..` |
| `collection_products` | M:N | PK `(collection_id,product_id)`; composite FKs on `(tenant_id, ...)` |
| `products` | Catalog | unique `(tenant_id,slug)`; partial unique `(tenant_id,sku)`; money `bigint` minor units 0..1e11; `quantity>=0`; `status draft\|active` |
| `product_images` | Media | composite FK to product; unique `storage_path`; one primary per product (partial unique); mime jpeg/png/webp; size 1..10 MiB |
| `product_options` | Variant axes | unique `(product_id,name)`; 1..50 values |
| `product_variants` | SKUs | unique `(product_id,options)`; partial unique `(tenant_id,sku)`; `quantity>=0` |
| `inventory_adjustments` | Append-only ledger | `delta<>0`, `quantity_after>=0`, reason enum |
| `customers` | Merchant customers | unique `(tenant_id, lower(email))` |
| `orders` | **Read-only** | unique `(tenant_id,order_number)`; status enum; no INSERT grant to `authenticated` |
| `order_items` | Order lines (snapshots) | composite FK to order |
| `platform_admins` | Platform staff | PK `user_id`; `role super_admin\|admin`; no grants, no policies |
| `platform_settings` | Singleton | `id boolean = true`; no grants |
| `admin_audit_logs` | Append-only | UPDATE/DELETE/TRUNCATE blocked by trigger; no grants |
| `rate_limits` | Fixed-window counters | PK `(key,window_start)`; no grants |
| `product_presentations` | Per-product design overrides (migrations 0032-0033) | PK `product_id`; composite FKs `(tenant_id,product_id)` and `(tenant_id,store_id)` (cascade); `draft` jsonb, `published` jsonb (NULL = never published), trigger-managed `revision`, `published_at`, `published_by`; JSON size and shape checks; RLS: members read, Owner/Admin write; shoppers read only the projection returned by `get_public_product` |

Tables intentionally **not modelled** (template customization, excluded): `templates`, `template_versions`, `store_template_settings`, template engine cutover tables. They are only touched through raw SQL inside the storage-reference check (below) so deleting a file can never break a template.

## Database functions the API calls (not re-implemented)

| Function | Used by |
|---|---|
| `is_platform_admin()`, `platform_admin_role()` | PlatformAdminGuard |
| `list_tenant_team(tenant)`, `remove_team_member(tenant,user)`, `update_team_member_name(tenant,user,name)` | Team |
| `is_store_slug_available(slug)` | Store settings, organization creation |
| `platform_provision_tenant(...)`, `platform_list_tenants(id)`, `platform_list_tenants_page(...)`, `platform_overview_stats()`, `platform_get_tenant_store(id)`, `platform_set_tenant_status`, `platform_update_tenant`, `platform_update_store`, `platform_delete_tenant`, `platform_add_member`, `platform_set_member_status`, `platform_remove_member`, `platform_assign_owner` | Platform organizations |
| `platform_list_admins()`, `platform_add_admin`, `platform_set_admin_role`, `platform_remove_admin` | Platform admins |
| `get_platform_settings()`, `platform_update_settings(...)`, `get_public_platform_settings()` | Settings / branding |
| `platform_record_audit(...)`, `platform_list_audit(...)`, `platform_audit_admins()` | Audit log |
| `platform_tenant_usage`, `platform_usage_page`, `platform_usage_summary`, `platform_inactive_organizations`, `platform_new_organizations_series` | Usage analytics |
| `rate_limit_admin(bucket,limit,window)` | Platform rate limits |
| `get_public_storefront(slug)` | Public storefront |

## Indexes (existing, unchanged)

See `drizzle/0000_baseline.sql` onward. Notable: `products_tenant_created_idx`, `products_tenant_status_idx`, `customers_tenant_created_idx`, `orders_tenant_placed_idx`, `inventory_adjustments_tenant_created_idx`, `admin_audit_logs_*`. No index changes are required by the API.

## Storage

Bucket `products` (public read). Layout: `{tenantId}/{productId}/{file}`, `{tenantId}/collections/{id}/{file}`, `{tenantId}/store/{file}`. Storage policies from `drizzle/0006` require tenant membership by path; the API calls Storage with the **caller's own bearer token** so those policies stay the authority.
