# Role & Permission Matrix

Ported 1:1 from `lib/auth/permissions.ts`. The database enforces the same rules through RLS (`drizzle/0002`, `0018`), so a bug here cannot widen access.

## Actors

| Actor | Source of truth |
|---|---|
| Platform Admin (`super_admin`, `admin`) | `platform_admins` via `is_platform_admin()` / `platform_admin_role()` |
| Owner | `memberships.role = 'owner'` (exactly one per organization) |
| Team member | `memberships.role = 'admin'` (legacy `staff` behaves identically) with `permissions` JSON per module |

Presets (labels only; only the permission levels are stored): **Manager** `products:write orders:read customers:write settings:write` - **Staff** `products:write orders:read customers:write settings:read` - **Viewer** all `read`. Anything else shows as "Custom". Orders can never be `write`.

## Effective access level

`owner` -> `write` on everything. Others -> `permissions[module] ?? none`, except **`settings` is never below `read`**. A `disabled` membership or `suspended` organization grants nothing (DB level).

## Permission rules

| Permission | Rule | Used by |
|---|---|---|
| `dashboard:view` | any member | `/organizations/current`, `/analytics` shell |
| `store:manage` | settings = write | `PATCH /store`, uploads scope `store` |
| `store:delete`, `tenant:delete` | Owner only | (no endpoint today) |
| `tenant:manage` | settings = write | - |
| `members:manage` | **Owner only** | all `/team/*` |
| `catalog:view` | products >= read | categories/collections/products/inventory reads |
| `catalog:manage` | products = write | catalog writes, stock adjust, uploads (non-store) |
| `catalog:delete` | products = write | catalog deletes |
| `orders:view` | orders >= read | analytics (recent orders / sales) |
| `customers:view` | customers >= read | customers reads |
| `customers:manage` / `customers:delete` | customers = write | customer writes |

Note: migration `0018` adds RESTRICTIVE RLS policies calling `has_module_access(tenant, module, level)` on every tenant table (read for SELECT, write for INSERT/UPDATE/DELETE), so the database already refuses module-less reads. The API applies the same permission in a guard first so callers get a clean 403 instead of an empty result.

## Platform Admin rules

| Capability | admin | super_admin |
|---|---|---|
| Organizations: list/detail/create/update/status/delete, store edit, members add/disable/remove, ownership transfer/recover | yes | yes |
| Usage analytics, audit log (read) | yes | yes |
| Platform admins: list | yes | yes |
| Platform admins: add / change level / remove | **no** (`FORBIDDEN`) | yes; last super admin can never be removed or demoted (SQL, under lock) |
| Platform settings: read | yes | yes |
| Platform settings: update | **no** | yes |
| Tenant data (catalog, customers, orders) | **never** (admin functions expose company metadata only) | **never** |

Platform authority and tenant roles are disjoint: an account that belongs to an organization cannot become a platform admin.

## Ownership transfer rules (preserved)

* Only a Platform Admin transfers/recovers ownership (no tenant-side endpoint exists).
* Transfer target must be an **active** team member, not already owner (`already_owner`, `not_eligible`).
* Recovery creates a brand-new confirmed account and makes it owner; the previous owner is kept or disabled (`previousOwner: keep|disable`).
* `platform_assign_owner` is atomic: never zero or two owners. The owner cannot be disabled/removed while owner.
* An Owner cannot edit/disable/remove themselves or another owner through Team endpoints (RLS + `ne(role,'owner')` + `ne(userId, self)`).

## Platform admin rate limits (per admin, per 10 min window)

`org.create 10`, `org.delete 5`, `org.edit 60`, `team.manage 30`, `ownership.change 5`, `admin.manage 10`, `settings.update 20` (database counters via `rate_limit_admin`; limiter outage fails open and is logged, as today).
