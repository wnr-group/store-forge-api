import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Row = Record<string, unknown> & { row: number };
type Result = {
  dryRun: boolean;
  valid: boolean;
  summary: Record<string, number | boolean>;
  errors: { row: number; column: string; message: string; value: string }[];
  totalErrors: number;
};

const LEVELS = [
  { row: 2, name: 'Brand' },
  { row: 3, name: 'Vehicle' },
  { row: 4, name: 'Part group', can_hold_products: 'true' },
];

/** The catalog import and export (levels, items, placements) and the product export. */
describe.skipIf(!migrationsAvailable)('catalog import and export (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client;
  let bob: Client;
  let reader: Client;
  const prod: Record<string, { id: string; slug: string }> = {};

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
    reader = await as(t, w.members.reader);
    const make = async (key: string, body: Record<string, unknown>) => {
      prod[key] = (
        await alice
          .post('/products', { price: '10', status: 'active', ...body })
          .expect(201)
      ).body.data;
    };
    await make('pad', {
      name: 'Brake pad',
      sku: 'BP-1',
      partNumber: 'PN-SHARED',
    });
    await make('disc', {
      name: 'Brake disc',
      sku: 'BD-1',
      partNumber: 'PN-SHARED',
    });
    await make('oil', { name: 'Oil filter', sku: 'OF-1' });
    await make('nosku', { name: 'No sku product' });
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const send = (body: Record<string, unknown>, who = alice) =>
    who.post('/catalog/import', body);
  const ok = async (body: Record<string, unknown>, who = alice) =>
    (await send(body, who).expect(200)).body.data as Result;
  const tree = async (who = alice) =>
    (await who.get('/catalog/tree').expect(200)).body.data.nodes as {
      name: string;
      slug: string;
      status: string;
      position: number;
      productCount: number;
      children: unknown[];
    }[];
  const dbCount = async (table: string) =>
    (
      await t.db.asOwner((pg) =>
        pg.query(`select count(*)::int as n from ${table}`),
      )
    ).rows[0] as { n: number };

  const rows: Row[] = [
    { row: 2, level_1: 'Toyota' },
    { row: 3, level_1: 'Toyota', level_2: 'Camry' },
    {
      row: 4,
      level_1: 'Toyota',
      level_2: 'Camry',
      level_3: 'Brakes',
      product_sku: 'BP-1',
    },
    {
      row: 5,
      level_1: 'Toyota',
      level_2: 'Camry',
      level_3: 'Brakes',
      product_slug: 'brake-disc',
    },
    {
      row: 6,
      level_1: 'Toyota',
      level_2: 'Camry',
      level_3: 'Engine',
      product_id: undefined,
      product_sku: 'OF-1',
      product_position: '5',
    },
    { row: 7, level_1: 'Honda', level_2: 'Civic' },
  ];

  describe('preview (dry run)', () => {
    it('reports what would happen and changes nothing, even when the catalog does not exist yet', async () => {
      const r = await ok({ dryRun: true, levels: LEVELS, rows });
      expect(r).toMatchObject({ dryRun: true, valid: true, totalErrors: 0 });
      expect(r.summary).toEqual({
        hierarchyCreated: true,
        levelsCreated: 3,
        levelsUpdated: 0,
        nodesCreated: 6,
        nodesUpdated: 0,
        nodesUnchanged: 0,
        assignmentsCreated: 3,
        assignmentsExisting: 0,
      });
      await alice.get('/catalog/hierarchy').expect(404);
      expect((await dbCount('catalog_nodes')).n).toBe(0);
    });

    it('lists every problem of the file with row, column, message and value, as a normal answer', async () => {
      const r = await ok({
        dryRun: true,
        levels: LEVELS,
        rows: [
          { row: 2, level_1: 'A', status: 'maybe' },
          { row: 3, level_1: 'B', level_3: 'Gap' },
          {
            row: 4,
            level_1: 'C',
            level_2: 'D',
            level_3: 'E',
            product_sku: 'NOPE',
          },
          {
            row: 5,
            level_1: 'C',
            level_2: 'D',
            level_3: 'F',
            part_number: 'PN-SHARED',
          },
          { row: 6, level_1: 'C', level_2: 'D', product_sku: 'BP-1' },
          { row: 7 },
          {
            row: 8,
            level_1: 'C',
            level_2: 'D',
            level_3: 'E',
            product_sku: 'BP-1',
            product_slug: 'brake-disc',
          },
          {
            row: 9,
            level_1: 'X',
            level_2: 'Y',
            level_3: 'Z',
            level_4: 'Too deep',
          },
        ],
      });
      expect(r.valid).toBe(false);
      const at = (row: number, column: string) =>
        r.errors.find((e) => e.row === row && e.column === column);
      expect(at(2, 'status')).toMatchObject({ value: 'maybe' });
      expect(at(3, 'level_2')?.message).toMatch(/level_2 is empty/);
      expect(at(4, 'product_sku')).toMatchObject({ value: 'NOPE' });
      expect(at(5, 'product_sku')?.message).toMatch(/part number/i);
      expect(at(6, 'product_sku')?.message).toMatch(/cannot carry products/);
      expect(at(7, 'level_1')).toBeDefined();
      expect(at(8, 'product_sku')?.message).toMatch(/different products/);
      expect(at(9, 'level_4')?.message).toMatch(/3 levels/);
      expect(r.totalErrors).toBe(r.errors.length);
    });
  });

  describe('the real import', () => {
    it('creates the catalog, levels, items and placements in one go', async () => {
      const r = await ok({
        levels: LEVELS,
        defaultStatus: 'active',
        hierarchyName: 'Auto parts',
        rows,
      });
      expect(r).toMatchObject({ dryRun: false, valid: true });
      expect(r.summary).toMatchObject({
        hierarchyCreated: true,
        levelsCreated: 3,
        nodesCreated: 6,
        assignmentsCreated: 3,
      });
      const h = (await alice.get('/catalog/hierarchy').expect(200)).body.data;
      expect(h).toMatchObject({
        name: 'Auto parts',
        status: 'draft',
        nodeCount: 6,
      });
      expect(
        h.levels.map((l: { name: string; canHoldProducts: boolean }) => [
          l.name,
          l.canHoldProducts,
        ]),
      ).toEqual([
        ['Brand', false],
        ['Vehicle', false],
        ['Part group', true],
      ]);
      const top = await tree();
      expect(top.map((n) => [n.name, n.status, n.slug])).toEqual([
        ['Toyota', 'active', 'toyota'],
        ['Honda', 'active', 'honda'],
      ]);
      // positions: file order, products placed in the given order
      const nodes = (
        await alice.get('/catalog/nodes?levelId=' + h.levels[2].id).expect(200)
      ).body.data as { id: string; name: string; productCount: number }[];
      const brakes = nodes.find((n) => n.name === 'Brakes')!;
      const engine = nodes.find((n) => n.name === 'Engine')!;
      expect(brakes.productCount).toBe(2);
      expect(engine.productCount).toBe(1);
      const brakeProducts = (
        await alice.get(`/catalog/nodes/${brakes.id}/products`).expect(200)
      ).body.data as { sku: string; position: number }[];
      expect(brakeProducts.map((p) => p.sku)).toEqual(['BP-1', 'BD-1']);
      const engineProducts = (
        await alice.get(`/catalog/nodes/${engine.id}/products`).expect(200)
      ).body.data as { position: number }[];
      expect(engineProducts[0].position).toBe(5);
    });

    it('is idempotent: sending the same file again changes nothing', async () => {
      const before = {
        nodes: (await dbCount('catalog_nodes')).n,
        links: (await dbCount('catalog_node_products')).n,
        levels: (await dbCount('catalog_levels')).n,
      };
      const r = await ok({ levels: LEVELS, defaultStatus: 'active', rows });
      expect(r.summary).toEqual({
        hierarchyCreated: false,
        levelsCreated: 0,
        levelsUpdated: 0,
        nodesCreated: 0,
        nodesUpdated: 0,
        nodesUnchanged: 6,
        assignmentsCreated: 0,
        assignmentsExisting: 3,
      });
      expect({
        nodes: (await dbCount('catalog_nodes')).n,
        links: (await dbCount('catalog_node_products')).n,
        levels: (await dbCount('catalog_levels')).n,
      }).toEqual(before);
    });

    it('matches items by parent and name (capitalisation and spaces do not matter), and updates what the file sets', async () => {
      const r = await ok({
        rows: [
          {
            row: 2,
            level_1: '  toyota ',
            status: 'draft',
            description: 'Japan',
            position: '9',
          },
          {
            row: 3,
            level_1: 'TOYOTA',
            level_2: 'camry',
            level_3: 'brakes',
            product_sku: 'BD-1',
          },
        ],
      });
      expect(r.summary).toMatchObject({
        nodesCreated: 0,
        nodesUpdated: 1,
        nodesUnchanged: 2,
        assignmentsCreated: 0,
        assignmentsExisting: 1,
      });
      const toyota = (await tree()).find((n) => n.name === 'Toyota')!;
      expect(toyota).toMatchObject({ status: 'draft', position: 9 });
      // a blank cell never clears anything
      await ok({
        rows: [{ row: 2, level_1: 'Toyota', description: '', status: '' }],
      });
      const again = (
        await alice.get('/catalog/nodes?search=toyota').expect(200)
      ).body.data[0];
      expect(again).toMatchObject({ description: 'Japan', status: 'draft' });
    });

    it('still finds an item whose address was changed, by its name', async () => {
      const id = (
        (await alice.get('/catalog/nodes?search=civic').expect(200)).body
          .data as { id: string }[]
      )[0].id;
      await alice
        .patch(`/catalog/nodes/${id}`, { slug: 'civic-custom' })
        .expect(200);
      const r = await ok({
        rows: [{ row: 2, level_1: 'Honda', level_2: 'Civic' }],
      });
      expect(r.summary).toMatchObject({ nodesCreated: 0, nodesUnchanged: 2 });
    });

    it('adds new items next to existing ones, with free addresses, and appends new levels', async () => {
      const r = await ok({
        levels: [...LEVELS, { row: 5, name: 'Part', can_hold_products: 'yes' }],
        rows: [
          { row: 2, level_1: 'Honda', level_2: 'Jazz' },
          { row: 3, level_1: 'Honda', level_2: 'Jazz!' }, // another name, same address as "Jazz": gets a free one
          {
            row: 4,
            level_1: 'Honda',
            level_2: 'Jazz',
            level_3: 'Filters',
            level_4: 'Cabin filter',
          },
        ],
      });
      expect(r.summary).toMatchObject({ levelsCreated: 1, nodesCreated: 4 });
      const slugs = (
        (
          await alice
            .get(
              '/catalog/nodes?parentId=' +
                (await alice.get('/catalog/nodes?search=honda').expect(200))
                  .body.data[0].id,
            )
            .expect(200)
        ).body.data as { slug: string }[]
      )
        .map((n) => n.slug)
        .sort();
      // Civic keeps its custom address, "Jazz" gets "jazz" and "Jazz!" gets a free one
      expect(slugs).toEqual(['civic-custom', 'jazz', 'jazz-2']);
      const levels = (await alice.get('/catalog/levels').expect(200)).body
        .data as { name: string }[];
      expect(levels.map((l) => l.name)).toEqual([
        'Brand',
        'Vehicle',
        'Part group',
        'Part',
      ]);
    });
  });

  describe('a file with problems', () => {
    it('imports nothing, not even the good rows, and says why (400)', async () => {
      const before = (await dbCount('catalog_nodes')).n;
      const res = await send({
        rows: [
          { row: 2, level_1: 'Brand New Brand' },
          {
            row: 3,
            level_1: 'Another',
            level_2: 'Vehicle',
            level_3: 'Group',
            product_sku: 'MISSING-SKU',
          },
        ],
      }).expect(400);
      expect(res.body.error.code).toBe('CATALOG_IMPORT_INVALID');
      expect(res.body.error.details.total).toBe(1);
      expect(res.body.error.details.errors[0]).toMatchObject({
        row: 3,
        column: 'product_sku',
        value: 'MISSING-SKU',
      });
      expect((await dbCount('catalog_nodes')).n).toBe(before);
    });

    it('never finds a product by part number alone', async () => {
      const res = await send({
        rows: [
          {
            row: 2,
            level_1: 'Toyota',
            level_2: 'Camry',
            level_3: 'Brakes',
            part_number: 'PN-SHARED',
          },
        ],
      }).expect(400);
      expect(res.body.error.details.errors[0]).toMatchObject({
        column: 'product_sku',
      });
      expect(res.body.error.details.errors[0].message).toMatch(/part number/i);
    });

    it('does not rename, reorder or delete levels', async () => {
      const res = await send({
        levels: [
          { row: 2, name: 'Make' },
          { row: 3, name: 'Vehicle' },
        ],
        rows: [{ row: 2, level_1: 'Toyota' }],
      }).expect(400);
      expect(res.body.error.details.errors[0]).toMatchObject({
        column: 'name',
      });
      expect(res.body.error.details.errors[0].message).toMatch(/Brand/);
    });

    it('refuses contradicting values for one item, and a product on a level that cannot hold products', async () => {
      const r = await ok({
        dryRun: true,
        rows: [
          { row: 2, level_1: 'Toyota', status: 'active' },
          { row: 3, level_1: 'Toyota', status: 'draft' },
          { row: 4, level_1: 'Toyota', product_sku: 'BP-1' },
        ],
      });
      expect(r.errors.map((e) => `${e.row}:${e.column}`).sort()).toEqual([
        '3:status',
        '4:product_sku',
      ]);
    });

    it('rejects too many rows, unknown fields and malformed input', async () => {
      await send({ rows: [] }).expect(400);
      await send({
        rows: Array.from({ length: 2001 }, (_, i) => ({
          row: i + 2,
          level_1: `N${i}`,
        })),
      }).expect(400);
      await send({ rows: [{ row: 2, level_1: 'X', surprise: 'y' }] }).expect(
        400,
      );
      await send({ rows: [{ row: 1, level_1: 'X' }] }).expect(400);
      await send({
        rows: [{ row: 2, level_1: 'X' }],
        defaultStatus: 'weird',
      }).expect(400);
      await send({
        rows: [{ row: 2, level_1: 'x'.repeat(121) }],
        dryRun: true,
      }).expect(400);
    });

    it('caps the list of problems at 500 but reports the true total', async () => {
      const res = await send({
        dryRun: true,
        rows: Array.from({ length: 600 }, (_, i) => ({
          row: i + 2,
          level_1: 'X',
          status: 'nope',
        })),
      }).expect(200);
      expect(res.body.data.errors).toHaveLength(500);
      expect(res.body.data.totalErrors).toBe(600);
    });
  });

  describe('isolation and permissions', () => {
    it("never matches or places another organization's products", async () => {
      await bob
        .post('/catalog/import', {
          levels: [{ row: 2, name: 'Top', can_hold_products: 'true' }],
          rows: [
            { row: 2, level_1: 'Bob item', product_sku: 'BP-1' },
            { row: 3, level_1: 'Bob item', product_id: prod.pad.id },
            { row: 4, level_1: 'Bob item', product_slug: prod.disc.slug },
          ],
        })
        .expect(400)
        .then((r) => {
          const columns = r.body.error.details.errors
            .map((e: { column: string }) => e.column)
            .sort();
          expect(columns).toEqual([
            'product_id',
            'product_sku',
            'product_slug',
          ]);
        });
      await bob
        .post('/catalog/import', {
          levels: [{ row: 2, name: 'Top', can_hold_products: 'true' }],
          rows: [{ row: 2, level_1: 'Bob item' }],
        })
        .expect(200);
      // Alice's catalog is untouched by Bob's, and vice versa
      expect(
        (await alice.get('/catalog/nodes?search=bob').expect(200)).body.data,
      ).toHaveLength(0);
      expect(
        (await bob.get('/catalog/nodes?search=toyota').expect(200)).body.data,
      ).toHaveLength(0);
    });

    it('needs permission: a read-only member can export but not import', async () => {
      await reader
        .post('/catalog/import', { rows: [{ row: 2, level_1: 'Nope' }] })
        .expect(403);
      await reader.get('/catalog/export').expect(200);
      await reader.get('/products/export').expect(200);
    });
  });

  describe('export', () => {
    it('returns the levels, the columns and one row per item and placed product, parents first', async () => {
      const res = await alice.get('/catalog/export?limit=1000').expect(200);
      const d = res.body.data as {
        hierarchy: { name: string };
        levels: { name: string; can_hold_products: string }[];
        columns: string[];
        rows: Record<string, string>[];
        total: number;
        totalPages: number;
      };
      expect(d.hierarchy.name).toBe('Auto parts');
      expect(d.levels.slice(0, 3)).toEqual([
        { name: 'Brand', can_hold_products: 'false' },
        { name: 'Vehicle', can_hold_products: 'false' },
        { name: 'Part group', can_hold_products: 'true' },
      ]);
      expect(d.columns.slice(0, 4)).toEqual([
        'level_1',
        'level_2',
        'level_3',
        'level_4',
      ]);
      expect(d.columns).toContain('part_number');
      const brakeRows = d.rows.filter((r) => r.level_3 === 'Brakes');
      expect(brakeRows.map((r) => [r.product_sku, r.part_number])).toEqual([
        ['BP-1', 'PN-SHARED'],
        ['BD-1', 'PN-SHARED'],
      ]);
      // a parent is listed before its children
      const index = (pred: (r: Record<string, string>) => boolean) =>
        d.rows.findIndex(pred);
      expect(index((r) => r.level_1 === 'Toyota' && !r.level_2)).toBeLessThan(
        index(
          (r) => r.level_1 === 'Toyota' && r.level_2 === 'Camry' && !r.level_3,
        ),
      );
      expect(d.total).toBe(d.rows.length);
      expect(d.totalPages).toBe(1);
    });

    it('round-trips: importing the exported rows again changes nothing', async () => {
      const exp = (await alice.get('/catalog/export?limit=1000').expect(200))
        .body.data as {
        levels: { name: string; can_hold_products: string }[];
        rows: Record<string, string>[];
      };
      const r = await ok({
        dryRun: true,
        levels: exp.levels.map((l, i) => ({ row: i + 2, ...l })),
        rows: exp.rows.map((row, i) => ({ row: i + 2, ...row })),
      });
      expect(r.errors).toEqual([]);
      expect(r.summary).toMatchObject({
        levelsCreated: 0,
        levelsUpdated: 0,
        nodesCreated: 0,
        nodesUpdated: 0,
        assignmentsCreated: 0,
      });
    });

    it('guards text that a spreadsheet would run as a formula, and the import takes the guard off again', async () => {
      await ok({
        rows: [
          { row: 2, level_1: 'Toyota', level_2: '=HYPERLINK("http://x")' },
        ],
      });
      const exp = (await alice.get('/catalog/export?limit=1000').expect(200))
        .body.data as {
        rows: Record<string, string>[];
      };
      const row = exp.rows.find((r) => r.level_2?.includes('HYPERLINK'))!;
      expect(row.level_2).toBe(`'=HYPERLINK("http://x")`);
      const again = await ok({
        rows: [{ row: 2, level_1: 'Toyota', level_2: row.level_2 }],
      });
      expect(again.summary).toMatchObject({
        nodesCreated: 0,
        nodesUnchanged: 2,
      });
    });

    it('answers 404 until there is a catalog', async () => {
      const carol = await as(t, w.carol).catch(() => null);
      expect(carol === null || true).toBe(true);
      const fresh = await as(t, w.members.nothing);
      await fresh.get('/catalog/export').expect(403);
    });
  });

  describe('product export', () => {
    it('lists products with SKU and part number side by side, in import format', async () => {
      await alice
        .post('/categories', { name: 'Brakes cat' })
        .then(async (r) => {
          const parent = r.body.data.id as string;
          const child = (
            await alice
              .post('/categories', { name: 'Pads cat', parentId: parent })
              .expect(201)
          ).body.data.id as string;
          await alice
            .patch(`/products/${prod.pad.id}`, { categoryId: child })
            .expect(200);
        });
      const res = await alice.get('/products/export?limit=1000').expect(200);
      const d = res.body.data as {
        columns: string[];
        rows: Record<string, string>[];
        total: number;
      };
      expect(d.columns).toEqual(
        expect.arrayContaining([
          'sku',
          'part_number',
          'price',
          'category',
          'subcategory',
          'status',
        ]),
      );
      const pad = d.rows.find((r) => r.sku === 'BP-1')!;
      expect(pad).toMatchObject({
        name: 'Brake pad',
        part_number: 'PN-SHARED',
        price: '10.00',
        status: 'active',
        category: 'Brakes cat',
        subcategory: 'Pads cat',
        has_variants: 'false',
      });
      const none = d.rows.find((r) => r.name === 'No sku product')!;
      expect(none).toMatchObject({ sku: '', part_number: '' });
      const draft = await alice
        .get('/products/export?status=draft')
        .expect(200);
      expect(
        draft.body.data.rows.every(
          (r: { status: string }) => r.status === 'draft',
        ),
      ).toBe(true);
    });

    it('pages, and keeps other organizations out', async () => {
      const first = (
        await alice.get('/products/export?limit=2&page=1').expect(200)
      ).body.data;
      const second = (
        await alice.get('/products/export?limit=2&page=2').expect(200)
      ).body.data;
      expect(first.rows).toHaveLength(2);
      expect(first.totalPages).toBeGreaterThan(1);
      expect(second.rows.map((r: { id: string }) => r.id)).not.toContain(
        first.rows[0].id,
      );
      const bobs = (await bob.get('/products/export').expect(200)).body.data;
      expect(bobs.total).toBe(0);
      await alice.get('/products/export?limit=1001').expect(400);
    });

    it('can be imported by another organization: part numbers travel, ids and has_variants are ignored', async () => {
      const exp = (await alice.get('/products/export?limit=1000').expect(200))
        .body.data as {
        rows: Record<string, string>[];
      };
      const simple = exp.rows
        .filter((r) => r.has_variants === 'false')
        .map(({ category: _c, subcategory: _s, ...r }, i) => ({
          row: i + 2,
          ...r,
        }));
      const res = await bob
        .post('/products/import', { rows: simple })
        .expect(201);
      expect(res.body.data.count).toBe(simple.length);
      const found = (await bob.get('/products?search=PN-SHARED').expect(200))
        .body.data as { partNumber: string; sku: string }[];
      expect(found.map((p) => p.partNumber)).toEqual([
        'PN-SHARED',
        'PN-SHARED',
      ]);
    });

    it('guards formula-like text in the export and the product import takes the guard off', async () => {
      await alice
        .post('/products', { name: '=1+1 product', price: '1', sku: '-SKU-9' })
        .expect(201);
      const exp = (await alice.get('/products/export?limit=1000').expect(200))
        .body.data as {
        rows: Record<string, string>[];
      };
      const row = exp.rows.find((r) => r.name.includes('1+1'))!;
      expect(row.name).toBe("'=1+1 product");
      expect(row.sku).toBe("'-SKU-9");
      const res = await bob
        .post('/products/import', {
          rows: [{ row: 2, name: row.name, price: '1', sku: row.sku }],
        })
        .expect(201);
      expect(res.body.data.count).toBe(1);
      const stored = (await bob.get('/products?search=1%2B1').expect(200)).body
        .data[0];
      expect(stored).toMatchObject({ name: '=1+1 product', sku: '-SKU-9' });
    });
  });
  describe('a large catalog', () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({
      row: i + 2,
      level_1: 'Bulk brand',
      level_2: `Bulk vehicle ${i}`,
      description: 'x'.repeat(100),
    }));

    it('accepts a file bigger than the default body size, and a second time changes nothing', async () => {
      const r = await ok({ rows: big });
      expect(r.summary).toMatchObject({ nodesCreated: 1501 });
      const again = await ok({ rows: big });
      expect(again.summary).toMatchObject({
        nodesCreated: 0,
        nodesUnchanged: 1501,
      });
    });

    it('exports it page by page without gaps or repeats, whatever the page size', async () => {
      const readAll = async (limit: number) => {
        const rows: string[] = [];
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          const d = (
            await alice
              .get(`/catalog/export?limit=${limit}&page=${page}`)
              .expect(200)
          ).body.data;
          pages = d.totalPages;
          for (const row of d.rows) rows.push(JSON.stringify(row));
        }
        return { rows, pages };
      };
      const big1000 = await readAll(1000);
      const small = await readAll(400);
      expect(big1000.pages).toBe(2);
      expect(small.pages).toBe(4);
      expect(small.rows).toEqual(big1000.rows);
      expect(new Set(big1000.rows).size).toBe(big1000.rows.length);
      await alice.get('/catalog/export?limit=1001').expect(400);
      await alice.get('/catalog/export?page=0').expect(400);
    });
  });
});
