import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductsService } from '../src/modules/products/products.service.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

describe.skipIf(!migrationsAvailable)('product import (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Awaited<ReturnType<typeof as>>;
  let bob: Awaited<ReturnType<typeof as>>;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const row = (n: number, over: Record<string, unknown> = {}) => ({
    row: n,
    name: `Imp ${n}`,
    price: '10.00',
    ...over,
  });
  const total = async (c: typeof alice) =>
    (await c.get('/products?limit=1').expect(200)).body.meta.total as number;

  it('AC-11: creates every row, with the manual-form defaults and the right statuses', async () => {
    const before = await total(alice);
    const res = await alice
      .post('/products/import', {
        rows: [
          row(2, { status: 'ACTIVE', sku: 'IMP-1' }),
          row(3, { track_inventory: 'no', quantity: '7' }),
          row(4),
        ],
      })
      .expect(201);
    expect(res.body.data).toEqual({ count: 3 });
    expect(await total(alice)).toBe(before + 3);
    const db = await t.db.asOwner((pg) =>
      pg.query(
        "select name,status,quantity,low_stock_threshold,track_inventory from products where name like 'Imp %' order by name",
      ),
    );
    expect(db.rows).toMatchObject([
      {
        status: 'active',
        quantity: 0,
        low_stock_threshold: 5,
        track_inventory: true,
      },
      { status: 'draft', quantity: 7, track_inventory: false },
      {
        status: 'draft',
        quantity: 0,
        low_stock_threshold: 5,
        track_inventory: true,
      },
    ]);
  });

  it('AC-12/14: an invalid file creates nothing and reports row, column, message, value, plus source_errors', async () => {
    const before = await total(alice);
    const res = await alice
      .post('/products/import', {
        rows: [
          row(2),
          row(3, { price: '0' }),
          row(4, {
            price: '',
            source_errors: [
              {
                column: 'cost',
                message: 'This cell contains a formula with no stored value.',
              },
            ],
          }),
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('PRODUCT_IMPORT_INVALID');
    expect(res.body.error.details.total).toBe(3);
    expect(res.body.error.details.errors).toEqual(
      expect.arrayContaining([
        { row: 3, column: 'price', message: expect.any(String), value: '0' },
      ]),
    );
    expect(await total(alice)).toBe(before);
  });

  it('AC-12: reports the true total when errors exceed 500', async () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row(i + 2, { price: '0', quantity: 'x' }),
    );
    const res = await alice.post('/products/import', { rows }).expect(400);
    expect(res.body.error.details.total).toBe(600);
    expect(res.body.error.details.errors).toHaveLength(500);
  });

  it('AC-13: more than 500 rows is rejected before any row is processed', async () => {
    await alice
      .post('/products/import', {
        rows: Array.from({ length: 501 }, (_, i) => row(i + 2)),
      })
      .expect(400);
  });

  it('AC-16: duplicate and existing SKUs/slugs are reported on the right rows; other tenants never conflict', async () => {
    await alice
      .post('/products', {
        name: 'Existing',
        price: '1.00',
        sku: 'EXIST-1',
        slug: 'existing-slug',
      })
      .expect(201);
    await bob
      .post('/products', { name: 'Bob', price: '1.00', sku: 'CROSS-1' })
      .expect(201);
    const res = await alice
      .post('/products/import', {
        rows: [
          row(2, { sku: 'EXIST-1' }),
          row(3, { slug: 'existing-slug' }),
          row(4, { sku: 'D-1' }),
          row(5, { sku: 'd-1' }),
          row(6, { sku: 'CROSS-1' }),
        ],
      })
      .expect(400);
    const pairs = res.body.error.details.errors.map(
      (e: { row: number; column: string }) => `${e.row}:${e.column}`,
    );
    expect(pairs).toEqual(['2:sku', '3:slug', '5:sku']);
  });

  it('resolves categories and subcategories; unknown, wrong-parent and ambiguous values are row errors', async () => {
    const p = (
      await alice.post('/categories', { name: 'Imp Apparel' }).expect(201)
    ).body.data;
    await alice
      .post('/categories', { name: 'Imp Shirts', parentId: p.id })
      .expect(201);
    const q = (await alice.post('/categories', { name: 'Imp Men' }).expect(201))
      .body.data;
    await alice
      .post('/categories', { name: 'Imp Trousers', parentId: q.id })
      .expect(201);
    const bad = await alice
      .post('/products/import', {
        rows: [
          row(2, { category: 'Imp Apparel', subcategory: 'Imp Trousers' }),
          row(3, { category: 'Nope' }),
          row(4, { subcategory: 'Imp Shirts' }),
        ],
      })
      .expect(400);
    expect(
      bad.body.error.details.errors.map(
        (e: { row: number; column: string }) => `${e.row}:${e.column}`,
      ),
    ).toEqual(['2:subcategory', '3:category', '4:subcategory']);
    await alice
      .post('/products/import', {
        rows: [
          row(2, { name: 'Cat only', category: 'imp apparel' }),
          row(3, {
            name: 'Sub too',
            category: 'Imp Apparel',
            subcategory: 'Imp Shirts',
          }),
        ],
      })
      .expect(201);
    const names = (
      await alice
        .get('/products?search=' + encodeURIComponent('Sub too'))
        .expect(200)
    ).body.data as { categoryName: string }[];
    expect(names[0].categoryName).toBe('Imp Shirts');
  });

  it('slugs: rows insert in file order; a later explicit slug coexists with an earlier generated one', async () => {
    const res = await alice
      .post('/products/import', {
        rows: [
          row(2, { name: 'Slug Tee' }),
          row(3, { name: 'Dup Name' }),
          row(4, { name: 'Dup Name' }),
          row(5, { name: 'Another', slug: 'slug-tee' }),
        ],
      })
      .expect(201);
    expect(res.body.data).toEqual({ count: 4 });
    const slugs = (
      await t.db.asOwner((pg) =>
        pg.query(
          "select name, slug from products where name in ('Slug Tee','Dup Name','Another') order by slug",
        ),
      )
    ).rows as { name: string; slug: string }[];
    expect(slugs.find((r) => r.name === 'Another')?.slug).toBe('slug-tee'); // the explicit slug wins its own row
    expect(slugs.find((r) => r.name === 'Slug Tee')?.slug).toBe('slug-tee-2'); // the generated slug steps aside
    expect(
      slugs.filter((r) => r.name === 'Dup Name').map((r) => r.slug),
    ).toEqual(['dup-name', 'dup-name-2']); // same-named rows get unique generated slugs
  });

  it('slugs: import allocates slugs in memory and never calls the per-row uniqueSlug lookup', async () => {
    const spy = vi.spyOn(
      ProductsService.prototype as unknown as {
        uniqueSlug: () => Promise<string>;
      },
      'uniqueSlug',
    );
    try {
      await alice
        .post('/products/import', {
          rows: [
            row(2, { name: 'Alloc Mug' }),
            row(3, { name: 'Alloc Mug' }),
            row(4, { name: 'Alloc Mug' }),
          ],
        })
        .expect(201);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const rows = (
      await t.db.asOwner((pg) =>
        pg.query(
          "select slug from products where name = 'Alloc Mug' order by slug",
        ),
      )
    ).rows as { slug: string }[];
    expect(rows.map((r) => r.slug)).toEqual([
      'alloc-mug',
      'alloc-mug-2',
      'alloc-mug-3',
    ]);
  });

  it('slugs: duplicate explicit slugs in one file are reported on the later row, case-insensitively', async () => {
    const res = await alice
      .post('/products/import', {
        rows: [
          row(2, { slug: 'dup-explicit' }),
          row(3),
          row(4, { slug: 'DUP-explicit' }),
        ],
      })
      .expect(400);
    expect(res.body.error.details.errors).toEqual([
      {
        row: 4,
        column: 'slug',
        message: expect.stringContaining('row 2'),
        value: 'dup-explicit',
      },
    ]); // the value shown is the normalised (lowercased) slug
  });

  it('slugs: another tenant never conflicts, and generated slugs are scoped to the caller tenant', async () => {
    await bob
      .post('/products', { name: 'Iso Bob', price: '1.00', slug: 'iso-slug' })
      .expect(201);
    await alice
      .post('/products/import', {
        rows: [
          row(2, { name: 'Iso Alice', slug: 'iso-slug' }),
          row(3, { name: 'Iso Bob' }),
        ],
      })
      .expect(201);
    const alices = (
      await t.db.asOwner((pg) =>
        pg.query(
          "select slug from products where tenant_id = $1 and name in ('Iso Alice','Iso Bob') order by name",
          [w.tenantA],
        ),
      )
    ).rows as { slug: string }[];
    expect(alices.map((r) => r.slug)).toEqual(['iso-slug', 'iso-bob']); // 'iso-bob' is free for Alice even though Bob owns that name
  });

  it('slugs: a database uniqueness violation after the pre-check rolls everything back as a file-level 409', async () => {
    // PGlite cannot run two genuinely concurrent transactions, so the race is simulated by making the 2nd insert raise the real constraint error
    // (the pre-check had passed). The genuine two-simultaneous-imports check is a staging step in the QA plan.
    const before = await total(alice);
    // oxlint-disable-next-line typescript/unbound-method
    const original = ProductsService.prototype.insertNewProductInTx;
    let calls = 0;
    const spy = vi
      .spyOn(ProductsService.prototype, 'insertNewProductInTx')
      .mockImplementation(async function (this: ProductsService, ...args) {
        if (++calls === 2)
          throw new Error(
            'duplicate key value violates unique constraint "products_tenant_id_sku_key"',
          );
        return original.apply(this, args);
      });
    try {
      const res = await alice
        .post('/products/import', {
          rows: [
            row(2, { name: 'Race A', sku: 'RACE-1' }),
            row(3, { name: 'Race B', sku: 'RACE-2' }),
          ],
        })
        .expect(409);
      expect(res.body.error.code).toMatch(/CONFLICT|SKU/);
      expect(res.body.error.details?.errors).toBeUndefined(); // file-level: no row list
    } finally {
      spy.mockRestore();
    }
    expect(await total(alice)).toBe(before);
  });

  it('AC-15: a failure during insertion rolls back every row', async () => {
    const before = await total(alice);
    // oxlint-disable-next-line typescript/unbound-method
    const original = ProductsService.prototype.insertNewProductInTx;
    let calls = 0;
    const spy = vi
      .spyOn(ProductsService.prototype, 'insertNewProductInTx')
      .mockImplementation(async function (this: ProductsService, ...args) {
        if (++calls === 3) throw new Error('forced failure');
        return original.apply(this, args);
      });
    try {
      await alice
        .post('/products/import', {
          rows: [
            row(2, { name: 'Roll A' }),
            row(3, { name: 'Roll B' }),
            row(4, { name: 'Roll C' }),
          ],
        })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await total(alice)).toBe(before);
    expect(
      (
        await t.db.asOwner((pg) =>
          pg.query(
            "select count(*)::int as n from products where name like 'Roll %'",
          ),
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  });

  it('AC-17: import and manual create store identical columns for equivalent input', async () => {
    const fields = {
      price: '12.50',
      compare_at_price: '20',
      cost: '4',
      sku: 'PAR-A',
      quantity: '3',
      low_stock_threshold: '2',
      track_inventory: 'false',
      status: 'active',
      description: 'd',
      short_description: 's',
      product_type: 't',
    };
    await alice
      .post('/products', {
        name: 'Parity manual',
        price: '12.50',
        compareAtPrice: '20',
        cost: '4',
        sku: 'PAR-M',
        quantity: 3,
        lowStockThreshold: 2,
        trackInventory: false,
        status: 'active',
        description: 'd',
        shortDescription: 's',
        productType: 't',
      })
      .expect(201);
    await alice
      .post('/products/import', {
        rows: [{ row: 2, name: 'Parity import', ...fields, sku: 'PAR-I' }],
      })
      .expect(201);
    const cols =
      'price_minor, compare_at_price_minor, cost_minor, has_variants, track_inventory, quantity, low_stock_threshold, status, product_type, description, short_description, category_id';
    const one = async (n: string) =>
      (
        await t.db.asOwner((pg) =>
          pg.query(`select ${cols} from products where name = $1`, [n]),
        )
      ).rows[0];
    expect(await one('Parity import')).toEqual(await one('Parity manual'));
  });

  it('AC-10: permissions and tenancy: a read-only member gets 403; unauthenticated gets 401', async () => {
    const reader = await as(t, w.members.reader);
    await reader.post('/products/import', { rows: [row(2)] }).expect(403);
    await anonymous(t)
      .post('/products/import', { rows: [row(2)] })
      .expect(401);
  });

  it('AC-18: the import route accepts 150 KB; the same body on another route is refused', async () => {
    await alice
      .post('/products/import', {
        rows: Array.from({ length: 10 }, (_, i) =>
          row(i + 2, { name: `Big ${i}`, description: 'x'.repeat(15_000) }),
        ),
      })
      .expect(201); // about 150 KB in total, every row valid
    await alice.post('/categories', { name: 'x'.repeat(150_000) }).expect(413);
  });
});
