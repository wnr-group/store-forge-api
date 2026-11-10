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
