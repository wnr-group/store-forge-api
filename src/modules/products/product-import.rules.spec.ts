import { describe, expect, it } from 'vitest';
import {
  assignSlugs,
  capErrors,
  findConflicts,
  findInFileDuplicates,
  initialSlugWindows,
  parseBoolean,
  resolveCategories,
  slugCandidates,
  slugRoot,
  validateRow,
  type CategoryRef,
  type ValidRow,
} from './product-import.rules.js';

const cats: CategoryRef[] = [
  { id: 'a', name: 'Apparel', slug: 'apparel', parentId: null },
  { id: 'a1', name: 'Shirts', slug: 'shirts', parentId: 'a' },
  { id: 'b', name: 'Men', slug: 'men', parentId: null },
  { id: 'b1', name: 'Shirts', slug: 'men-shirts', parentId: 'b' },
  { id: 'c', name: 'apparel', slug: 'apparel-2', parentId: null },
];

describe('parseBoolean', () => {
  it.each([
    ['TRUE', true],
    ['yes', true],
    ['1', true],
    ['No', false],
    ['0', false],
  ])('%s', (v, out) => expect(parseBoolean(v)).toBe(out));
  it('rejects other text', () => expect(parseBoolean('maybe')).toBe('invalid'));
});

describe('validateRow', () => {
  it('applies the manual-form defaults', async () => {
    const r = await validateRow({ row: 2, name: 'Tee', price: '499.00' });
    expect(r.errors).toEqual([]);
    expect(r.valid?.values).toMatchObject({
      status: 'draft',
      quantity: 0,
      lowStockThreshold: 5,
      trackInventory: true,
      price: '499.00',
    });
  });
  it.each(['', '0', '0.00', '-1'])(
    'rejects price %j on the price column',
    async (price) => {
      const r = await validateRow({ row: 7, name: 'Tee', price });
      expect(r.errors.map((e) => [e.row, e.column])).toContainEqual([
        7,
        'price',
      ]);
    },
  );
  it('reports a missing price and name', async () => {
    const r = await validateRow({ row: 3 });
    expect(r.errors.map((e) => e.column).sort()).toEqual(['name', 'price']);
  });
  it('rejects compare-at not above price, bad boolean and bad status', async () => {
    const r = await validateRow({
      row: 4,
      name: 'T',
      price: '10',
      compare_at_price: '10',
      track_inventory: 'maybe',
      status: 'live',
    });
    expect(r.errors.map((e) => e.column).sort()).toEqual([
      'compare_at_price',
      'status',
      'track_inventory',
    ]);
  });
  it('merges source_errors without skipping validation of other cells', async () => {
    const r = await validateRow({
      row: 9,
      name: 'T',
      price: '0',
      source_errors: [
        {
          column: 'cost',
          message: 'This cell contains a formula with no stored value.',
        },
      ],
    });
    expect(r.errors.map((e) => e.column).sort()).toEqual(['cost', 'price']);
  });
  it('keeps at most one error per column and truncates value to 100 chars', async () => {
    const r = await validateRow({ row: 5, name: 'T'.repeat(300), price: 'x' });
    expect(r.errors.filter((e) => e.column === 'name')).toHaveLength(1);
    expect(r.errors.every((e) => e.value.length <= 100)).toBe(true);
  });
});

describe('resolveCategories', () => {
  const run = (category?: string, subcategory?: string) =>
    resolveCategories([{ row: 2, category, subcategory }], cats);
  it('maps category only, category + subcategory, and blank', () => {
    expect(run('Men').ids.get(2)).toBe('b');
    expect(run('men', 'shirts').ids.get(2)).toBe('b1'); // never a1: "Shirts" under another parent is not considered
    expect(run('apparel-2').ids.get(2)).toBe('c'); // exact handle
    expect(run(undefined, undefined).ids.get(2)).toBeNull();
  });
  it('rejects an ambiguous name and tells the merchant to use the handle', () => {
    const r = run('Apparel'); // matches the names "Apparel" (a) and "apparel" (c)
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 2, column: 'category' });
    expect(r.errors[0].message).toContain('more than one');
  });
  it('rejects a subcategory without a category, unknown values, and a subcategory of another parent', () => {
    expect(run(undefined, 'Shirts').errors[0].column).toBe('subcategory');
    expect(run('Nope').errors[0].column).toBe('category');
    expect(run('Men', 'Trousers').errors[0].message).toContain('was not found');
    expect(run('apparel-2', 'Shirts').errors[0].message).toContain(
      'is not a subcategory of',
    );
  });
});

describe('duplicates and conflicts', () => {
  it('reports the later row and names the first', async () => {
    const a = (
      await validateRow({
        row: 2,
        name: 'A',
        price: '1',
        sku: 'Sku-1',
        slug: 'aa',
      })
    ).valid!;
    const b = (
      await validateRow({
        row: 6,
        name: 'B',
        price: '1',
        sku: 'SKU-1',
        slug: 'AA',
      })
    ).valid!;
    const errs = findInFileDuplicates([a, b]);
    expect(errs.map((e) => [e.row, e.column])).toEqual([
      [6, 'sku'],
      [6, 'slug'],
    ]);
    expect(errs[0].message).toContain('row 2');
  });
  it('flags existing SKUs (exact) and slugs on the right rows', async () => {
    const a = (
      await validateRow({
        row: 8,
        name: 'A',
        price: '1',
        sku: 'X1',
        slug: 'taken',
      })
    ).valid!;
    expect(
      findConflicts([a], new Set(['X1']), new Set(['taken'])).map(
        (e) => e.column,
      ),
    ).toEqual(['sku', 'slug']);
    expect(findConflicts([a], new Set(['x1']), new Set())).toEqual([]);
  });
});

describe('capErrors', () => {
  it('sorts by row then column, keeps the true total, caps at 500', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({
      row: 700 - i,
      column: 'price',
      message: 'm',
      value: '',
    }));
    const out = capErrors(many);
    expect(out.total).toBe(700);
    expect(out.errors).toHaveLength(500);
    expect(out.errors[0].row).toBe(1);
  });
});

describe('slug allocation', () => {
  const vr = (row: number, name: string, explicitSlug: string | null = null) =>
    ({
      row,
      values: { name },
      sku: null,
      explicitSlug,
    }) as unknown as ValidRow;

  it('slugRoot pads like uniqueSlug', () => {
    expect(slugRoot('Blue Shirt')).toBe('blue-shirt');
    expect(slugRoot('A')).toBe('a-item');
    expect(slugRoot('!!!')).toBe('product-item');
  });

  it('allocates in file order: root, root-2, root-3', () => {
    const rows = [vr(2, 'Mug'), vr(3, 'Mug'), vr(4, 'Mug')];
    const w = initialSlugWindows(rows);
    const out = assignSlugs(rows, new Set(), w);
    expect([...out.slugs.values()]).toEqual(['mug', 'mug-2', 'mug-3']);
  });

  it('skips slugs taken in the database and reports a short window', () => {
    const rows = [vr(2, 'Mug'), vr(3, 'Mug')];
    const w = initialSlugWindows(rows);
    const out = assignSlugs(rows, new Set(['mug', 'mug-2']), w);
    expect(out.slugs.size).toBe(0);
    expect([...out.short]).toEqual(['mug']);
    w.set('mug', 6);
    expect(slugCandidates(w)).toContain('mug-6');
    const again = assignSlugs(rows, new Set(['mug', 'mug-2']), w);
    expect([...again.slugs.values()]).toEqual(['mug-3', 'mug-4']);
  });

  it("reserves a later row's explicit slug", () => {
    const rows = [vr(2, 'Mug'), vr(3, 'Other', 'mug')];
    const first = assignSlugs(rows, new Set(), initialSlugWindows(rows));
    expect([...first.short]).toEqual(['mug']); // window too small: the service widens it and retries
    const out = assignSlugs(rows, new Set(), new Map([['mug', 5]]));
    expect(out.slugs.get(2)).toBe('mug-2');
  });
});
