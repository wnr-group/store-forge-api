# Catalog hierarchy

A store owner describes the catalogue as a tree with **any number of named levels**, for example `Brand > Vehicle > Variant > Part group`, and places products on its items. One product can sit on many items (no copies of the product). Categories and collections are **not** changed: this is a separate structure.

Migrations: `0072_catalog_hierarchy_core.sql` (tables, integrity, security, `products.part_number`) and `0073_catalog_hierarchy_public.sql` (public reads). Code: `src/modules/catalog-hierarchy/`, models in `src/database/schema/catalog-hierarchy.ts`. Routes: `API_ENDPOINT_INVENTORY.md`, section "Catalog hierarchy".

## Data model

| Table | Purpose |
|---|---|
| `catalog_hierarchies` | The hierarchy: `name`, `status` (`draft` / `active`). **One per organization for now** (unique index `catalog_hierarchies_one_per_tenant_idx`; dropping that index is all it takes to allow several, every other table already carries `hierarchy_id`). |
| `catalog_levels` | Named levels, numbered `1..n` without gaps (max 20). `can_hold_products` says whether items of the level may carry products (default `false`). Unique name per hierarchy, case-insensitive. |
| `catalog_nodes` | The items. `parent_id`, `level_id`, `name`, `slug` (unique among siblings), `description`, `position`, `status`, SEO fields. `path_ids` (ids from the top down to the item) and `depth` are maintained by a trigger and can never be written by a client. |
| `catalog_node_products` | Many-to-many link `(node_id, product_id)` with a `position`. |
| `products.part_number` | Nullable, **not unique**, max 64 characters; index `(tenant_id, part_number)`. The SKU is untouched and stays the stable product identifier. |

Every row has `tenant_id`; children point at parents through composite `(tenant_id, ...)` foreign keys, so a row can never reference another organization's row, even for a privileged writer.

### Rules the database enforces (triggers, so they hold for every writer)

* A **top-level item is on level 1**; any other item is on **the level right after its parent's level**. No cycles. The level and hierarchy of an item never change; a move changes only the parent, and the whole subtree gets its new `path_ids` / `depth` (`catalog_nodes_after_move`).
* **Level numbering** is `1..n` without gaps. Changing the order of levels is checked when the transaction commits (a deferred constraint trigger, so swapping two numbers works): it is refused (`CATALOG_LEVEL_ORDER_BLOCKED`) when any existing parent/child relation would stop being "right below its parent", or a top-level item would leave level 1.
* **Products only on levels that allow them** (`CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS`), and `can_hold_products` cannot be switched off while products are placed on items of the level (`CATALOG_LEVEL_HAS_PRODUCTS`).
* Structural changes of one hierarchy are serialized with a transaction-level advisory lock.

### Security

* RLS on all four tables: members read; owner / admin / staff write (the roles of `collection_products`), plus **restrictive policies** that need the member's **Products** permission (`read` to see, `write` to change), exactly as the other catalogue tables (migration 0018).
* Column-level grants: `UPDATE` is limited to the columns that belong to the client (never `tenant_id`, `hierarchy_id`, `level_id`, `path_ids`, `depth` of an existing row). `INSERT` is table-wide (like the other catalogue tables) but `path_ids` / `depth` are always overwritten by the trigger.
* Public reads go through `SECURITY DEFINER` functions with an empty `search_path` that take the **store slug** (never a tenant id), answer only for an active store of an active organization, and return only **active items whose ancestors are all active** and **active products**. The tables are not readable without a user.

### Level reordering: what "safe" means

Levels can be renamed freely (items keep their place). A new order is **accepted only if it keeps every existing relation valid**; otherwise nothing changes and the answer lists the reasons (`details.problems`). In practice: levels that no item uses can be moved or inserted anywhere; two levels that have items related to each other cannot be swapped, and a level cannot be inserted between a used parent level and its used child level, because that would invert or break the tree. Re-parenting items automatically was deliberately **not** done. To restructure a populated hierarchy, move the items (`POST /catalog/nodes/:id/move`) or use the import.

## Part number

* `part_number` is accepted on product create / update (`partNumber`), returned by list and detail, searchable in the admin product list, copied by "duplicate product" (the SKU is not), and imported / exported. Orders keep using the SKU.
* It is never used to identify a product: the catalog import finds products by `product_id`, `product_sku` or `product_slug`, and a row that only has a part number is an error.
* Public: `get_public_product()` returns `product.part_number`; catalog listings return `partNumber` on every product card.

## Public API (one shape for every storefront template)

`GET /public/storefronts/:slug/catalog/tree?maxDepth=` returns

```json
{ "store": { "name": "", "slug": "", "currency": "INR" },
  "hierarchy": { "id": "", "name": "" },
  "levels": [ { "id": "", "name": "Brand", "position": 1, "canHoldProducts": false } ],
  "nodes": [ { "id": "", "parentId": null, "levelId": "", "name": "Toyota", "slug": "toyota",
               "path": "toyota", "description": null, "position": 0, "depth": 1,
               "seoTitle": null, "seoDescription": null, "hasChildren": true, "productCount": 0 } ],
  "truncated": false }
```

`GET /public/storefronts/:slug/catalog/nodes/:path?page&limit&includeDescendants&sort` (`:path` = slugs from the top, joined by `/`, e.g. `toyota/camry/brakes`) returns `store`, `hierarchy`, `node` (with its `level`), `breadcrumbs[]`, `children[]` (same shape as tree nodes) and `products: { items[], page, limit, total, includeDescendants }`. A product card is `{ name, slug, partNumber, shortDescription, priceMinor, compareAtPriceMinor, imagePath, available }`. `sort` = `position` (default), `newest`, `name`, `price_asc`, `price_desc`; `limit` 1..100.

Rules: unknown / inactive / suspended store -> 404; no active hierarchy -> the tree is empty (`hierarchy: null`) and any item is 404; a draft item, or any item below a draft item, is 404 and absent from the tree; draft products never appear. `productCount` counts the active products placed **directly** on an item. The response contains no tenant or internal ids beyond the item / level / hierarchy ids shown above. Responses are not cached by the API; add a short CDN or framework cache in front if needed (the data changes only when the owner edits the catalog).

## Import and export

The frontend reads the CSV / Excel file and sends **JSON rows** (like the product import); no file upload and no spreadsheet library on the server.

`POST /catalog/import` body: `{ dryRun?, hierarchyName?, defaultStatus?, levels?[], rows[] }` (max 2000 rows, 2 MB; send bigger files in several requests, parents before children: every request is idempotent).

* **`levels`** (optional, "levels sheet"): `{ row, name, can_hold_products? }`, top level first. Created if missing. An import **never renames, reorders or deletes** levels: the first levels of the file must be the existing ones (same names); extra levels are appended; `can_hold_products` may be changed when given.
* **`rows`** ("items sheet"), one row per item, optionally with one product:

  | Column | Meaning |
  |---|---|
  | `row` | spreadsheet row number (header = 1), used in error messages |
  | `level_1` ... `level_20` | names from the top level down; the row is about the item of the **last filled** cell; no gaps |
  | `status` | `draft` / `active` (new items without one get `defaultStatus`, default `draft`) |
  | `description`, `position` | optional; an empty cell never clears anything |
  | `product_id` / `product_sku` / `product_slug` | place this product on the item; if several are given they must name the same product |
  | `product_position` | order of the product on the item |
  | `part_number`, `product_name` | information only (they come from the export); ignored, and a row with only these is an error |
  | `source_errors` | `[{column, message}]` problems the frontend found while reading the row |

* **Matching** (this makes the import idempotent): an item is the child of its parent whose name matches (case and extra spaces ignored), else whose address equals the address made from the name; a placement is the pair (item, product). Sending the same file twice changes nothing; the answer says `nodesUnchanged` / `assignmentsExisting`.
* **Preview**: `dryRun: true` always answers 200 with `{ valid, summary, errors[<=500], totalErrors }` and changes nothing. Errors are `{ row, column, message, value }`.
* **Commit**: everything is validated first against the database (products, levels, existing items) inside one transaction; any problem -> `400 CATALOG_IMPORT_INVALID` with `{ total, errors }` and **nothing is written**; otherwise everything is written in that same transaction (all or nothing).
* New items get an address made from the name, made unique among their siblings; new items without a `position` go after the existing siblings in file order.

`GET /catalog/export?page&limit` (<= 1000 rows per page) returns `{ hierarchy, levels[], columns[], rows[], page, limit, total, totalPages }`: the `levels` and the `rows` can be written straight into the two sheets and imported again unchanged. `GET /products/export` does the same for products (columns of the product import plus `id` and `has_variants`, which the import ignores; `part_number` next to `sku`).

**Formula safety.** Text a spreadsheet would run as a formula (starts with `=`, `+`, `-`, `@`, tab or carriage return) is exported with one leading apostrophe; the product and catalog imports remove an apostrophe that sits in front of such a character, so export -> import is lossless.

## Limits (technical safety limits, not plan entitlements: V1 has no catalog plan limit)

20 levels; 100000 items per hierarchy; 2000 rows per import request; 500 products per placement request; 100 items x 500 products (max 20000 pairs) per bulk placement; admin tree and public tree return at most 5000 items (`truncated`); 500 children per public item page; export pages of at most 1000 rows.

## Rollback

The migrations are additive and there is no down-migration convention in this project. To undo them by hand (in this order, after the code is rolled back): drop the public functions `get_public_catalog_tree(text,integer)` and `get_public_catalog_node(text,text,integer,integer,boolean,text)`; restore `get_public_product` from `0033_product_presentations_public_functions.sql`; drop tables `catalog_node_products`, `catalog_nodes`, `catalog_levels`, `catalog_hierarchies` (`CASCADE`); drop the functions `catalog_nodes_before_write`, `catalog_nodes_after_move`, `catalog_levels_integrity`, `catalog_levels_products_flag`, `catalog_node_products_level_check`; drop index `products_tenant_part_number_idx`, constraint `products_part_number_check` and column `products.part_number`. Dropping the tables removes the catalog structure and the placements, never the products.

## Known limitations

* One hierarchy per organization (by design, see above).
* No images on items (no upload folder / storage policy for them yet).
* Reordering levels that have related items is refused instead of restructuring the tree.
* `productCount` is direct only (no count that includes descendants), to keep the public tree cheap.
* Public listings return `partNumber` for catalog listings and in the product page; the older storefront and collection cards are unchanged.
