import { assertProductRules, type ProductValues } from './product-rules.js';

const base = (over: Partial<ProductValues> = {}): ProductValues => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Tee',
  description: null,
  shortDescription: null,
  productType: null,
  categoryId: null,
  collectionIds: [],
  sku: null,
  price: '100',
  compareAtPrice: null,
  cost: null,
  trackInventory: true,
  quantity: 0,
  lowStockThreshold: 5,
  weightGrams: 0,
  taxRateBps: null,
  hsnCode: null,
  status: 'draft',
  options: [],
  variants: [],
  images: [],
  ...over,
});

const variant = (size: string, over = {}) => ({
  options: { Size: size },
  sku: null,
  price: '100',
  compareAtPrice: null,
  quantity: 1,
  imagePath: null,
  isActive: true,
  ...over,
});

const problems = (p: ProductValues) => {
  try {
    assertProductRules(p);
  } catch (e) {
    const err = e as { details: Record<string, string> | null; code: string };
    return err.details ?? { code: err.code };
  }
  return null;
};

describe('product business rules', () => {
  it('accepts a simple product and a consistent variant set', () => {
    expect(problems(base())).toBeNull();
    expect(
      problems(
        base({
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [variant('S'), variant('M')],
        }),
      ),
    ).toBeNull();
  });

  it('compare-at must be strictly greater than the price (product and variants)', () => {
    expect(problems(base({ compareAtPrice: '100' }))).toEqual({
      compareAtPrice: 'Compare-at price must be greater than the price.',
    });
    expect(problems(base({ compareAtPrice: '99.99' }))).toHaveProperty(
      'compareAtPrice',
    );
    expect(problems(base({ compareAtPrice: '100.01' }))).toBeNull();
    expect(problems(base({ compareAtPrice: '1,000' }))).toBeNull(); // thousands separators are understood
    const v = problems(
      base({
        options: [{ name: 'Size', values: ['S'] }],
        variants: [variant('S', { compareAtPrice: '50' })],
      }),
    );
    expect(v).toHaveProperty(['variants.0.compareAtPrice']);
  });

  it('options need variants and variants need options', () => {
    expect(
      problems(base({ options: [{ name: 'Size', values: ['S'] }] })),
    ).toEqual({
      variants: 'Generate at least one variant.',
    });
    expect(problems(base({ variants: [variant('S')] }))).toEqual({
      variants: 'Variants need at least one option.',
    });
  });

  it('option names and values must be unique (case-insensitive)', () => {
    expect(
      problems(
        base({
          options: [
            { name: 'Size', values: ['S'] },
            { name: 'size', values: ['M'] },
          ],
          variants: [variant('S')],
        }),
      ),
    ).toHaveProperty('options');
    expect(
      problems(
        base({
          options: [{ name: 'Size', values: ['S', 's'] }],
          variants: [variant('S')],
        }),
      ),
    ).toHaveProperty(['options.0.values']);
  });

  it('a SKU cannot repeat inside one submission (case-insensitive); the product SKU is ignored when there are variants', () => {
    expect(
      problems(
        base({
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [variant('S', { sku: 'A' }), variant('M', { sku: 'a' })],
        }),
      ),
    ).toHaveProperty(['variants.1.sku']);
    expect(
      problems(
        base({
          sku: 'A',
          options: [{ name: 'Size', values: ['S'] }],
          variants: [variant('S', { sku: 'A' })],
        }),
      ),
    ).toBeNull();
  });

  it('variants must use declared options and values, once per combination', () => {
    const opts = [{ name: 'Size', values: ['S'] }];
    expect(
      problems(base({ options: opts, variants: [variant('XL')] })),
    ).toEqual({
      code: 'INVALID_VARIANT',
    });
    expect(
      problems(
        base({
          options: opts,
          variants: [{ ...variant('S'), options: { Colour: 'Red' } }],
        }),
      ),
    ).toEqual({ code: 'INVALID_VARIANT' });
    expect(
      problems(base({ options: opts, variants: [variant('S'), variant('S')] })),
    ).toEqual({ code: 'DUPLICATE_VARIANT' });
  });
});
