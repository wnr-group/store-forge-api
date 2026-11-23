import { describe, expect, it } from 'vitest';
import {
  mergeLines,
  priceLines,
  stockKey,
  type CatalogProduct,
  type CatalogVariant,
} from './checkout-pricing.js';

const product = (over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: 'p1',
  slug: 'mug',
  name: 'Mug',
  sku: 'MUG',
  status: 'active',
  priceMinor: 25000,
  hasVariants: false,
  trackInventory: true,
  quantity: 10,
  weightGrams: 0,
  ...over,
});
const variant = (over: Partial<CatalogVariant> = {}): CatalogVariant => ({
  id: 'v1',
  productId: 'p2',
  title: 'Large',
  sku: 'TEE-L',
  priceMinor: 120000,
  isActive: true,
  quantity: 4,
  ...over,
});
const tee = product({
  id: 'p2',
  slug: 'tee',
  name: 'Tee',
  hasVariants: true,
  quantity: 0,
});

describe('priceLines', () => {
  it('prices from the catalog, never from the shopper', () => {
    const r = priceLines(
      [{ productSlug: 'mug', variantId: null, quantity: 3 }],
      [product()],
      [],
      new Map(),
    );
    expect(r.issues).toEqual([]);
    expect(r.lines[0]).toMatchObject({
      unitPriceMinor: 25000,
      totalMinor: 75000,
    });
    expect(r.subtotalMinor).toBe(75000);
  });

  it('uses the variant price, name and SKU', () => {
    const r = priceLines(
      [{ productSlug: 'tee', variantId: 'v1', quantity: 2 }],
      [tee],
      [variant()],
      new Map(),
    );
    expect(r.lines[0]).toMatchObject({
      name: 'Tee - Large',
      sku: 'TEE-L',
      unitPriceMinor: 120000,
      totalMinor: 240000,
    });
  });

  it('flags a price that moved since the shopper added it', () => {
    const r = priceLines(
      [
        {
          productSlug: 'mug',
          variantId: null,
          quantity: 1,
          expectedUnitPriceMinor: 19900,
        },
      ],
      [product()],
      [],
      new Map(),
    );
    expect(r.issues).toEqual([
      {
        code: 'PRICE_CHANGED',
        productSlug: 'mug',
        variantId: null,
        currentUnitPriceMinor: 25000,
      },
    ]);
  });

  it('rejects draft products, unknown products and inactive or foreign variants', () => {
    const lines = [
      { productSlug: 'ghost', variantId: null, quantity: 1 },
      { productSlug: 'mug', variantId: null, quantity: 1 },
      { productSlug: 'tee', variantId: null, quantity: 1 },
      { productSlug: 'tee', variantId: 'v1', quantity: 1 },
    ];
    const r = priceLines(
      lines,
      [product({ status: 'draft' }), tee],
      [variant({ isActive: false })],
      new Map(),
    );
    expect(r.issues.map((i) => i.code)).toEqual([
      'PRODUCT_UNAVAILABLE',
      'PRODUCT_UNAVAILABLE',
      'VARIANT_REQUIRED',
      'VARIANT_UNAVAILABLE',
    ]);
    expect(
      priceLines(
        [{ productSlug: 'tee', variantId: 'v1', quantity: 1 }],
        [tee],
        [variant({ productId: 'other' })],
        new Map(),
      ).issues[0].code,
    ).toBe('VARIANT_UNAVAILABLE');
  });

  it('subtracts stock held by other unpaid orders', () => {
    const r = priceLines(
      [{ productSlug: 'mug', variantId: null, quantity: 4 }],
      [product({ quantity: 10 })],
      [],
      new Map([[stockKey('p1', null), 7]]),
    );
    expect(r.issues).toEqual([
      {
        code: 'OUT_OF_STOCK',
        productSlug: 'mug',
        variantId: null,
        available: 3,
      },
    ]);
  });

  it('does not limit products that do not track inventory', () => {
    const r = priceLines(
      [{ productSlug: 'mug', variantId: null, quantity: 99 }],
      [product({ trackInventory: false, quantity: 0 })],
      [],
      new Map(),
    );
    expect(r.issues).toEqual([]);
  });

  it('checks the merged quantity of a repeated item against stock', () => {
    const r = priceLines(
      [
        { productSlug: 'mug', variantId: null, quantity: 6 },
        { productSlug: 'mug', variantId: null, quantity: 6 },
      ],
      [product({ quantity: 10 })],
      [],
      new Map(),
    );
    expect(r.issues[0]).toMatchObject({ code: 'OUT_OF_STOCK', available: 10 });
  });
});

describe('mergeLines', () => {
  it('adds quantities for the same product and variant only', () => {
    const merged = mergeLines([
      { productSlug: 'a', variantId: null, quantity: 1 },
      { productSlug: 'a', variantId: null, quantity: 2 },
      { productSlug: 'a', variantId: 'v', quantity: 1 },
    ]);
    expect(merged.map((l) => l.quantity)).toEqual([3, 1]);
  });
});
