import { AppException, conflict, forbidden, invalid } from './app.exception.js';

/** Messages from the whole error chain (Drizzle wraps the driver error in `cause`). */
export function errorChain(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause)
    parts.push(e.message);
  return parts.join(' | ');
}

type Rule = { match: RegExp; error: () => AppException };

const field = (name: string, message: string) => ({ [name]: message });

/** Known constraint names -> messages that are safe to show (ported from lib/db/errors.ts). Anything else is rethrown. */
const RULES: Rule[] = [
  // Catalog hierarchy (migration 0072). Listed first: a few table names end in "products" and would match older rules.
  {
    match: /catalog_hierarchies_one_per_tenant_idx/,
    error: () =>
      conflict(
        'Your catalog hierarchy already exists.',
        undefined,
        'CATALOG_HIERARCHY_EXISTS',
      ),
  },
  {
    match: /catalog_levels_name_key/,
    error: () =>
      conflict(
        'Another level already has that name.',
        field('name', 'This name is already in use.'),
        'CATALOG_LEVEL_NAME_TAKEN',
      ),
  },
  {
    match: /catalog_nodes_root_slug_key|catalog_nodes_child_slug_key/,
    error: () =>
      conflict(
        'Another item with the same parent already uses that address.',
        field('slug', 'This slug is already in use.'),
        'CATALOG_NODE_SLUG_TAKEN',
      ),
  },
  {
    match: /CATALOG_NODE_LEVEL_MISMATCH/,
    error: () =>
      invalid(
        'An item has to sit on the level right below its parent (top-level items on the first level).',
        undefined,
        'CATALOG_NODE_LEVEL_MISMATCH',
      ),
  },
  {
    match: /CATALOG_NODE_CYCLE/,
    error: () =>
      invalid(
        'An item cannot be moved under itself or under one of its own descendants.',
        undefined,
        'CATALOG_NODE_CYCLE',
      ),
  },
  {
    match: /CATALOG_NODE_LEVEL_IMMUTABLE/,
    error: () =>
      invalid(
        'The level of an item cannot be changed.',
        undefined,
        'CATALOG_NODE_LEVEL_IMMUTABLE',
      ),
  },
  {
    match: /CATALOG_PARENT_NOT_FOUND|CATALOG_LEVEL_NOT_FOUND/,
    error: () =>
      invalid(
        'The parent item or the level no longer exists.',
        undefined,
        'CATALOG_PARENT_NOT_FOUND',
      ),
  },
  {
    match: /CATALOG_LEVEL_ORDER_BLOCKED/,
    error: () =>
      conflict(
        'The levels cannot be put in this order, because existing items depend on the current order.',
        undefined,
        'CATALOG_LEVEL_ORDER_BLOCKED',
      ),
  },
  {
    match: /CATALOG_LEVEL_NUMBERING|catalog_levels_position_key/,
    error: () =>
      conflict(
        'The levels were changed at the same time. Reload and try again.',
        undefined,
        'CATALOG_LEVEL_CONFLICT',
      ),
  },
  {
    match: /CATALOG_LEVEL_HAS_PRODUCTS/,
    error: () =>
      conflict(
        'Products are still placed on items of this level. Take them off first.',
        undefined,
        'CATALOG_LEVEL_HAS_PRODUCTS',
      ),
  },
  {
    match: /CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS/,
    error: () =>
      invalid(
        'Products cannot be placed on items of this level.',
        undefined,
        'CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS',
      ),
  },
  {
    match: /catalog_nodes_level_fk/,
    error: () =>
      conflict(
        'That level still has items.',
        undefined,
        'CATALOG_LEVEL_IN_USE',
      ),
  },
  {
    match: /catalog_nodes_parent_fk/,
    error: () =>
      conflict(
        'That item still has items below it.',
        undefined,
        'CATALOG_NODE_HAS_CHILDREN',
      ),
  },
  {
    match: /catalog_nodes_slug_check/,
    error: () =>
      invalid(
        'Use lowercase letters, numbers and single hyphens, up to 80 characters.',
        field('slug', 'This is not a valid slug.'),
        'CATALOG_NODE_SLUG_INVALID',
      ),
  },
  {
    match: /catalog_node_products_product_fk|catalog_node_products_node_fk/,
    error: () =>
      invalid(
        'The product or the item no longer exists.',
        undefined,
        'CATALOG_TARGET_NOT_FOUND',
      ),
  },
  {
    match: /products_pkey|collections_pkey/,
    error: () =>
      conflict('An item with that id already exists.', undefined, 'ID_TAKEN'),
  },
  {
    match: /products_tenant_id_slug_key/,
    error: () =>
      conflict(
        'That URL handle is already used by another product.',
        field('slug', 'This slug is already in use.'),
        'PRODUCT_SLUG_TAKEN',
      ),
  },
  {
    match: /products_tenant_id_sku_key|product_variants_tenant_id_sku_key/,
    error: () =>
      conflict(
        'That SKU is already used.',
        field('sku', 'This SKU is already in use.'),
        'SKU_TAKEN',
      ),
  },
  {
    match: /categories_tenant_id_slug_key/,
    error: () =>
      conflict(
        'That URL handle is already used by another category.',
        field('slug', 'This slug is already in use.'),
        'CATEGORY_SLUG_TAKEN',
      ),
  },
  {
    match: /collections_tenant_id_slug_key/,
    error: () =>
      conflict(
        'That URL handle is already used by another collection.',
        field('slug', 'This slug is already in use.'),
        'COLLECTION_SLUG_TAKEN',
      ),
  },
  {
    match: /customers_tenant_id_email_key/,
    error: () =>
      conflict(
        'A customer with that email already exists.',
        field('email', 'A customer with this email address already exists.'),
        'CUSTOMER_EMAIL_TAKEN',
      ),
  },
  {
    match: /store_pages_store_slug_key/,
    error: () =>
      conflict(
        'Another page already uses that address.',
        field('slug', 'This address is already in use.'),
        'PAGE_SLUG_TAKEN',
      ),
  },
  {
    match: /store_pages_slug_reserved_check/,
    error: () =>
      invalid(
        'That address is used by the store itself.',
        field('slug', 'Please pick another address.'),
        'PAGE_SLUG_RESERVED',
      ),
  },
  {
    match: /stores_slug_key/,
    error: () =>
      conflict(
        'That store address is already taken.',
        field('slug', 'This store address is already taken.'),
        'STORE_SLUG_TAKEN',
      ),
  },
  {
    match: /product_variants_product_id_options_key/,
    error: () =>
      invalid(
        'Two variants have the same option combination.',
        undefined,
        'DUPLICATE_VARIANT',
      ),
  },
  {
    match:
      /(product_variants|products)_quantity_check|inventory_adjustments_quantity_after_check/,
    error: () =>
      invalid('Stock cannot go below zero.', undefined, 'NEGATIVE_STOCK'),
  },
  {
    match: /product_images_one_primary_idx/,
    error: () => invalid('A product can only have one primary image.'),
  },
  {
    match: /categories_parent_check/,
    error: () => invalid('A category cannot be its own parent.'),
  },
  {
    match: /THEME_NOT_AVAILABLE/,
    error: () =>
      conflict(
        'That theme is not available any more. Please choose another.',
        undefined,
        'THEME_NOT_AVAILABLE',
      ),
  },
  {
    match: /templates_draft_check|template_versions_document_check/,
    error: () =>
      invalid(
        'That design is too large or not in the expected format.',
        undefined,
        'TEMPLATE_DOCUMENT_INVALID',
      ),
  },
  {
    match: /dc_tenant_code_key/,
    error: () =>
      conflict(
        'That discount code already exists.',
        field('code', 'This code is already in use.'),
        'DISCOUNT_CODE_TAKEN',
      ),
  },
  {
    match: /pc_tenant_name_key/,
    error: () =>
      conflict(
        'A campaign with that name already exists.',
        field('name', 'This name is already in use.'),
        'CAMPAIGN_NAME_TAKEN',
      ),
  },
  {
    match: /dc_campaign_fk/,
    error: () =>
      invalid(
        'That campaign no longer exists.',
        field('campaignId', 'Choose a campaign from your store.'),
        'CAMPAIGN_NOT_FOUND',
      ),
  },
  {
    match: /(dct|ct)_(product|collection)_fk/,
    error: () =>
      invalid(
        'One of the selected products or collections no longer exists.',
        field('productIds', 'Choose products and collections from your store.'),
        'TARGET_NOT_FOUND',
      ),
  },
  { match: /row-level security|permission denied/, error: () => forbidden() },
];

/** Translates database errors into client-safe exceptions; unknown errors pass through unchanged. */
export function mapDbError(error: unknown): unknown {
  if (error instanceof AppException) return error;
  const msg = errorChain(error);
  for (const rule of RULES) if (rule.match.test(msg)) return rule.error();
  return error;
}

/** Runs `fn`, mapping known constraint failures. */
export async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapDbError(e);
  }
}
