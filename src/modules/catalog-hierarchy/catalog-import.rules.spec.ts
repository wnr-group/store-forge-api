import {
  cellOf,
  mergeAttributes,
  nameKey,
  normName,
  parseLevels,
  parseRow,
  pathKey,
  reconcileLevels,
} from './catalog-import.rules.js';

const row = (n: number, over: Record<string, unknown> = {}) =>
  ({ row: n, ...over }) as never;

describe('cells', () => {
  it('trims, treats blanks as missing and removes the formula guard', () => {
    expect(cellOf('  x ')).toBe('x');
    expect(cellOf('')).toBeUndefined();
    expect(cellOf('   ')).toBeUndefined();
    expect(cellOf(undefined)).toBeUndefined();
    expect(cellOf("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(cellOf(5)).toBe('5');
  });

  it('identifies a name regardless of capitalisation and spacing', () => {
    expect(normName('  Toyota   Camry ')).toBe('Toyota Camry');
    expect(nameKey('  Toyota   CAMRY ')).toBe('toyota camry');
    expect(pathKey(['a', 'b'])).not.toBe(pathKey(['a b']));
  });
});

describe('parseRow', () => {
  it('reads the item of the last filled level and its attributes', () => {
    const { parsed, errors } = parseRow(
      row(2, {
        level_1: 'Toyota',
        level_2: ' Camry ',
        status: 'ACTIVE',
        description: 'Sedan',
        position: '3',
        product_sku: 'SKU-1',
        product_position: '7',
      }),
    );
    expect(errors).toEqual([]);
    expect(parsed).toMatchObject({
      names: ['Toyota', 'Camry'],
      keys: ['toyota', 'camry'],
      depth: 2,
      status: 'active',
      description: 'Sedan',
      position: 3,
      product: { sku: 'SKU-1' },
      productPosition: 7,
    });
  });

  it('needs level_1 and no gaps between the filled levels', () => {
    expect(parseRow(row(2)).errors[0]).toMatchObject({ column: 'level_1' });
    const gap = parseRow(row(3, { level_1: 'A', level_3: 'C' }));
    expect(gap.errors).toEqual([
      expect.objectContaining({ row: 3, column: 'level_2' }),
    ]);
  });

  it('checks status, numbers and product references', () => {
    const { errors } = parseRow(
      row(4, {
        level_1: 'A',
        status: 'live',
        position: '-1',
        product_id: 'nope',
        product_slug: 'Not A Slug!',
        product_sku: 'x'.repeat(65),
        product_position: 'abc',
      }),
    );
    expect(errors.map((e) => e.column).sort()).toEqual([
      'position',
      'product_id',
      'product_position',
      'product_sku',
      'product_slug',
      'status',
    ]);
    expect(errors.every((e) => e.row === 4)).toBe(true);
  });

  it('never accepts a part number (or a name) as the only way to find a product', () => {
    const a = parseRow(row(2, { level_1: 'A', part_number: 'PN-1' }));
    expect(a.errors[0]).toMatchObject({ column: 'product_sku' });
    expect(a.errors[0].message).toMatch(/part number/i);
    const b = parseRow(row(3, { level_1: 'A', product_name: 'Pad' }));
    expect(b.errors).toHaveLength(1);
    // with a real reference the part number is just information
    const c = parseRow(
      row(4, { level_1: 'A', part_number: 'PN-1', product_sku: 'S' }),
    );
    expect(c.errors).toEqual([]);
    expect(c.parsed?.product).toEqual({ sku: 'S' });
  });

  it('turns problems found by the frontend into errors', () => {
    const { errors } = parseRow(
      row(5, {
        level_1: 'A',
        source_errors: [{ column: 'description', message: 'formula' }],
      }),
    );
    expect(errors).toEqual([
      expect.objectContaining({ row: 5, column: 'description' }),
    ]);
  });

  it('lowercases ids and slugs, keeps SKUs as they are', () => {
    const { parsed } = parseRow(
      row(2, {
        level_1: 'A',
        product_id: '6A0D8092-DC42-42A3-8DDC-A24F9AA3C7BD',
        product_sku: 'Ab-1',
        product_slug: 'Brake-Pad',
      }),
    );
    expect(parsed?.product).toEqual({
      id: '6a0d8092-dc42-42a3-8ddc-a24f9aa3c7bd',
      sku: 'Ab-1',
      slug: 'brake-pad',
    });
  });
});

describe('mergeAttributes', () => {
  const parsed = (n: number, status?: 'draft' | 'active', position?: number) =>
    parseRow(row(n, { level_1: 'A', status, position: position?.toString() }))
      .parsed!;

  it('merges what different rows say about one item', () => {
    const { attributes, errors } = mergeAttributes([
      parsed(2, 'active'),
      parsed(3, undefined, 4),
      parsed(4, 'active', 4),
    ]);
    expect(errors).toEqual([]);
    expect(attributes.get(pathKey(['a']))).toEqual({
      status: 'active',
      position: 4,
      description: undefined,
    });
  });

  it('reports a contradiction on the later row', () => {
    const { errors } = mergeAttributes([
      parsed(2, 'active'),
      parsed(3, 'draft'),
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ row: 3, column: 'status' }),
    ]);
    expect(errors[0].message).toContain('row 2');
  });
});

describe('levels', () => {
  const have = [
    { id: 'l1', name: 'Brand', position: 1, canHoldProducts: false },
    { id: 'l2', name: 'Vehicle', position: 2, canHoldProducts: false },
  ];

  it('reads the levels sheet', () => {
    const { levels, errors } = parseLevels([
      { row: 2, name: ' Brand ', can_hold_products: 'No' },
      { row: 3, name: 'Part', can_hold_products: 'yes' },
    ]);
    expect(errors).toEqual([]);
    expect(levels).toEqual([
      { row: 2, name: 'Brand', canHold: false },
      { row: 3, name: 'Part', canHold: true },
    ]);
  });

  it('rejects empty, repeated and long names and a bad flag', () => {
    const { errors } = parseLevels([
      { row: 2, name: '' },
      { row: 3, name: 'A' },
      { row: 4, name: 'a' },
      { row: 5, name: 'x'.repeat(61) },
      { row: 6, name: 'B', can_hold_products: 'sometimes' },
    ]);
    expect(errors.map((e) => `${e.row}:${e.column}`)).toEqual([
      '2:name',
      '4:name',
      '5:name',
      '6:can_hold_products',
    ]);
  });

  it('keeps the existing levels when the file has none', () => {
    const r = reconcileLevels(have, []);
    expect(r.final.map((l) => l.name)).toEqual(['Brand', 'Vehicle']);
    expect(r.create).toEqual([]);
    expect(r.update).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('creates every level of an empty catalog, with the flag or false', () => {
    const r = reconcileLevels(
      [],
      [
        { row: 2, name: 'Top' },
        { row: 3, name: 'Parts', canHold: true },
      ],
    );
    expect(r.create).toEqual([
      { name: 'Top', position: 1, canHoldProducts: false },
      { name: 'Parts', position: 2, canHoldProducts: true },
    ]);
    expect(r.final.map((l) => l.id)).toEqual([null, null]);
  });

  it('appends new levels and updates only the flag of existing ones', () => {
    const r = reconcileLevels(have, [
      { row: 2, name: 'brand', canHold: undefined },
      { row: 3, name: 'VEHICLE', canHold: true },
      { row: 4, name: 'Part', canHold: true },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.update).toEqual([{ id: 'l2', canHoldProducts: true }]);
    expect(r.create).toEqual([
      { name: 'Part', position: 3, canHoldProducts: true },
    ]);
    expect(r.final.map((l) => [l.name, l.canHoldProducts])).toEqual([
      ['Brand', false],
      ['Vehicle', true],
      ['Part', true],
    ]);
  });

  it('never renames or reorders existing levels', () => {
    const renamed = reconcileLevels(have, [{ row: 2, name: 'Make' }]);
    expect(renamed.errors[0]).toMatchObject({ row: 2, column: 'name' });
    const swapped = reconcileLevels(have, [
      { row: 2, name: 'Vehicle' },
      { row: 3, name: 'Brand' },
    ]);
    expect(swapped.errors).toHaveLength(2);
  });

  it('refuses more than 20 levels', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      row: i + 2,
      name: `L${i}`,
    }));
    expect(reconcileLevels([], many).errors[0]).toMatchObject({
      column: 'levels',
    });
  });
});
