import { invalid } from '../../common/app.exception.js';
import { moneyValue } from '../../common/validation/fields.js';

/** A fully-specified product as the service sees it (after defaults / PATCH merging). Money stays decimal text. */
export interface VariantValues {
  id?: string;
  options: Record<string, string>;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  quantity: number;
  imagePath: string | null;
  isActive: boolean;
}

export interface ProductValues {
  id: string;
  name: string;
  slug?: string;
  description: string | null;
  shortDescription: string | null;
  productType: string | null;
  categoryId: string | null;
  collectionIds: string[];
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  cost: string | null;
  trackInventory: boolean;
  quantity: number;
  lowStockThreshold: number;
  weightGrams: number;
  /** GST rate in basis points, or null for the organization's default. */
  taxRateBps: number | null;
  hsnCode: string | null;
  status: 'draft' | 'active';
  options: { name: string; values: string[] }[];
  variants: VariantValues[];
  images: { path: string; altText: string | null }[];
}

export const MAX_VARIANTS = 100;

const COMPARE_AT = 'Compare-at price must be greater than the price.';

/** Compare-at only makes sense as a "was" price, so it must exceed the selling price. */
function compareAtProblem(price: string, compareAt: string | null): boolean {
  if (compareAt === null) return false;
  const p = moneyValue(price);
  const c = moneyValue(compareAt);
  return p !== null && c !== null && c <= p;
}

/**
 * Cross-field rules of a product (ports `productInputSchema.superRefine` and the service-level `checkVariants`).
 * Throws one VALIDATION error whose `details` maps field paths to messages.
 */
export function assertProductRules(p: ProductValues): void {
  const problems: Record<string, string> = {};

  if (compareAtProblem(p.price, p.compareAtPrice))
    problems['compareAtPrice'] = COMPARE_AT;
  p.variants.forEach((v, i) => {
    if (compareAtProblem(v.price, v.compareAtPrice))
      problems[`variants.${i}.compareAtPrice`] = COMPARE_AT;
  });

  const names = p.options.map((o) => o.name.toLowerCase());
  if (new Set(names).size !== names.length)
    problems['options'] = 'Option names must be unique.';
  p.options.forEach((o, i) => {
    const lower = o.values.map((x) => x.toLowerCase());
    if (new Set(lower).size !== lower.length)
      problems[`options.${i}.values`] = 'Option values must be unique.';
  });

  if (p.options.length > 0 && p.variants.length === 0)
    problems['variants'] = 'Generate at least one variant.';
  if (p.options.length === 0 && p.variants.length > 0)
    problems['variants'] = 'Variants need at least one option.';

  // A SKU identifies one sellable unit, so it cannot repeat inside the same submission. With variants the
  // product-level SKU is discarded by the service, so only variant SKUs compete.
  const seen = new Set<string>();
  const claim = (value: string | null, path: string) => {
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key))
      problems[path] = 'This SKU is used more than once on this product.';
    else seen.add(key);
  };
  if (p.variants.length === 0) claim(p.sku, 'sku');
  p.variants.forEach((v, i) => claim(v.sku, `variants.${i}.sku`));

  if (Object.keys(problems).length > 0)
    throw invalid('Please check the details you entered.', problems);

  checkVariants(p);
}

/** Variants must use exactly the declared options and only declared values, once per combination. */
export function checkVariants(p: ProductValues): void {
  const declared = new Map(p.options.map((o) => [o.name, new Set(o.values)]));
  const seen = new Set<string>();
  for (const v of p.variants) {
    const keys = Object.keys(v.options);
    if (
      keys.length !== declared.size ||
      !keys.every((k) => declared.get(k)?.has(v.options[k]))
    )
      throw invalid(
        'A variant uses an option value that does not exist.',
        undefined,
        'INVALID_VARIANT',
      );
    const signature = JSON.stringify(
      [...keys].sort().map((k) => [k, v.options[k]]),
    );
    if (seen.has(signature))
      throw invalid(
        'Two variants have the same option combination.',
        undefined,
        'DUPLICATE_VARIANT',
      );
    seen.add(signature);
  }
}
