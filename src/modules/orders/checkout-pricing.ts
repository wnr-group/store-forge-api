/**
 * Pure checkout pricing and stock validation. The browser's prices, names and stock are never trusted: every figure here
 * comes from catalog rows the service just read (and locked) in the database. The only thing taken from the shopper is
 * WHICH product, which variant and how many; an `expectedUnitPriceMinor` is used solely to notice that a price moved.
 */
export interface RequestedLine {
  productSlug: string;
  variantId: string | null;
  quantity: number;
  /** The unit price the shopper saw. Never used to price the order, only to detect a change. */
  expectedUnitPriceMinor?: number;
}

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  sku: string | null;
  status: string;
  priceMinor: number;
  hasVariants: boolean;
  trackInventory: boolean;
  quantity: number;
}

export interface CatalogVariant {
  id: string;
  productId: string;
  title: string;
  sku: string | null;
  priceMinor: number;
  isActive: boolean;
  quantity: number;
}

export interface PricedLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  trackInventory: boolean;
}

export type CheckoutIssueCode =
  | 'PRODUCT_UNAVAILABLE'
  | 'VARIANT_REQUIRED'
  | 'VARIANT_UNAVAILABLE'
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED';

export interface CheckoutIssue {
  code: CheckoutIssueCode;
  productSlug: string;
  variantId: string | null;
  /** OUT_OF_STOCK: how many can still be bought. */
  available?: number;
  /** PRICE_CHANGED: the current unit price. */
  currentUnitPriceMinor?: number;
}

export const stockKey = (productId: string, variantId: string | null) =>
  `${productId}:${variantId ?? '-'}`;

/** Merges lines for the same product and variant (a shopper cannot hold one item as two reservations). */
export function mergeLines(lines: readonly RequestedLine[]): RequestedLine[] {
  const merged = new Map<string, RequestedLine>();
  for (const line of lines) {
    const key = `${line.productSlug}:${line.variantId ?? '-'}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += line.quantity;
    else merged.set(key, { ...line });
  }
  return [...merged.values()];
}

/**
 * Prices the lines from the catalog and checks them against `reserved` (stock held by other unpaid orders). Returns every
 * problem at once so the shopper can fix the cart in one go. When `issues` is non-empty, `lines` must not be used.
 */
export function priceLines(
  requested: readonly RequestedLine[],
  products: readonly CatalogProduct[],
  variants: readonly CatalogVariant[],
  reserved: ReadonlyMap<string, number>,
): { lines: PricedLine[]; subtotalMinor: number; issues: CheckoutIssue[] } {
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const lines: PricedLine[] = [];
  const issues: CheckoutIssue[] = [];

  for (const line of mergeLines(requested)) {
    const base = { productSlug: line.productSlug, variantId: line.variantId };
    const product = bySlug.get(line.productSlug);
    if (!product || product.status !== 'active') {
      issues.push({ code: 'PRODUCT_UNAVAILABLE', ...base });
      continue;
    }
    let variant: CatalogVariant | undefined;
    if (product.hasVariants) {
      if (!line.variantId) {
        issues.push({ code: 'VARIANT_REQUIRED', ...base });
        continue;
      }
      variant = variantById.get(line.variantId);
      if (!variant || variant.productId !== product.id || !variant.isActive) {
        issues.push({ code: 'VARIANT_UNAVAILABLE', ...base });
        continue;
      }
    } else if (line.variantId) {
      issues.push({ code: 'VARIANT_UNAVAILABLE', ...base });
      continue;
    }

    const unitPriceMinor = variant ? variant.priceMinor : product.priceMinor;
    if (
      line.expectedUnitPriceMinor !== undefined &&
      line.expectedUnitPriceMinor !== unitPriceMinor
    ) {
      issues.push({
        code: 'PRICE_CHANGED',
        ...base,
        currentUnitPriceMinor: unitPriceMinor,
      });
      continue;
    }

    if (product.trackInventory) {
      const onHand = variant ? variant.quantity : product.quantity;
      const held = reserved.get(stockKey(product.id, variant?.id ?? null)) ?? 0;
      const available = Math.max(0, onHand - held);
      if (line.quantity > available) {
        issues.push({ code: 'OUT_OF_STOCK', ...base, available });
        continue;
      }
    }

    lines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      name: variant ? `${product.name} - ${variant.title}` : product.name,
      sku: variant ? (variant.sku ?? product.sku) : product.sku,
      quantity: line.quantity,
      unitPriceMinor,
      totalMinor: unitPriceMinor * line.quantity,
      trackInventory: product.trackInventory,
    });
  }

  const subtotalMinor = lines.reduce((sum, l) => sum + l.totalMinor, 0);
  if (!Number.isSafeInteger(subtotalMinor))
    issues.push({
      code: 'PRODUCT_UNAVAILABLE',
      productSlug: requested[0]?.productSlug ?? '',
      variantId: null,
    });
  return { lines, subtotalMinor, issues };
}
