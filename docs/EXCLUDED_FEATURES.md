# Excluded Features

## 1. Template customization (excluded by instruction)

Not implemented, not modelled, not exposed:

| Area | Existing source |
|---|---|
| Template engine, registry, presets, compile/validate/migrate | `lib/templates/**` |
| Draft / version / publish / rollback | `services/storefront-template.service.ts` |
| Per-store template settings (accent colour, hero heading/sub/image) | `services/template-settings.service.ts`, `lib/db/schema/store-template-settings.ts` |
| Engine cutover | `services/engine-cutover.service.ts`, `scripts/resync-legacy-templates.ts` |
| Dashboard page + actions | `app/(dashboard)/dashboard/templates/*` |
| Tables | `templates`, `template_versions`, `store_template_settings`, cutover tables |

Two intentional touch points so excluding templates cannot break data:

1. **Storage reference check.** `findReferencedPaths` also tests `store_template_settings.hero_image_path`, `templates.draft` and `template_versions.document` through raw SQL, so deleting a product/collection/logo image never removes a file a template still shows. Those tables are read, never written, and not defined in Drizzle.
2. **Public storefront.** `get_public_storefront(slug)` already embeds a `template` object chosen by the database. The API returns the function's JSON unchanged (as `template`, nullable); it does no template rendering and has no template endpoints.

## 2. Features that do not exist in the original app (not invented)

| Brief item | Status |
|---|---|
| Signup / registration, email verification, forgot password, invitations | Absent in StoreForge; absent here |
| Orders create / update / delete, order list | Absent: orders are read-only with no UI list. Orders appear in customer history and analytics only |
| Subscriptions, billing, integrations | No tables, services or UI |
| Separate reports module | Covered by analytics |
| Tenant-side ownership transfer | Platform Admin only today |

## 3. Handled outside the API

| Item | Where |
|---|---|
| Login, logout, token refresh | Supabase SDK in the client |
| Login rate limiting (`rate_limit_login`) | Cannot be applied by an API that never sees logins; flagged for the integration phase |
| Subdomain/host-based store selection, cookies, redirects | Frontend concern; replaced by the `X-Organization-Id` hint |
| Next.js cache tags / `revalidatePath` | Not applicable |
