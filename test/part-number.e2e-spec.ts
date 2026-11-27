import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

/** products.part_number: nullable, NOT unique, separate from the SKU (migration 0072). */
describe.skipIf(!migrationsAvailable)('product part number (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client;
  let bob: Client;

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

  const create = async (body: Record<string, unknown>, who = alice) =>
    (
      await who
        .post('/products', { price: '10.00', status: 'active', ...body })
        .expect(201)
    ).body.data as {
      id: string;
      slug: string;
      sku: string | null;
      partNumber: string | null;
    };

  it('is optional: a product without one reads back null', async () => {
    const p = await create({ name: 'No part number' });
    expect(p.partNumber).toBeNull();
  });

  it('is saved on create, returned by get and list, and independent of the SKU', async () => {
    const p = await create({
      name: 'With part number',
      sku: 'SKU-PN-1',
      partNumber: '  04152-YZZA1  ',
    });
    expect(p.partNumber).toBe('04152-YZZA1');
    expect(p.sku).toBe('SKU-PN-1');
    const got = (await alice.get(`/products/${p.id}`).expect(200)).body.data;
    expect(got).toMatchObject({ partNumber: '04152-YZZA1', sku: 'SKU-PN-1' });
    const list = (await alice.get('/products?search=04152-YZZ').expect(200))
      .body.data as { id: string; partNumber: string | null; sku: string }[];
    expect(list.map((x) => x.id)).toContain(p.id);
    expect(list.find((x) => x.id === p.id)).toMatchObject({
      partNumber: '04152-YZZA1',
      sku: 'SKU-PN-1',
    });
  });

  it('is NOT unique: two products (even in one organization) can share a part number, the SKU still is unique', async () => {
    const a = await create({ name: 'Shared A', partNumber: 'SHARED-1' });
    const b = await create({ name: 'Shared B', partNumber: 'SHARED-1' });
    expect(a.partNumber).toBe(b.partNumber);
    expect(a.id).not.toBe(b.id);
    await create({ name: 'Other org', partNumber: 'SHARED-1' }, bob);
    await create({ name: 'Sku one', sku: 'DUP-SKU' });
    const dup = await alice
      .post('/products', { name: 'Sku two', price: '1', sku: 'DUP-SKU' })
      .expect(409);
    expect(dup.body.error.code).toBe('SKU_TAKEN');
  });

  it('can be changed and cleared with PATCH, and the SKU is untouched by it', async () => {
    const p = await create({
      name: 'Patch me',
      sku: 'PATCH-SKU',
      partNumber: 'PN-OLD',
    });
    const changed = (
      await alice
        .patch(`/products/${p.id}`, { partNumber: 'PN-NEW' })
        .expect(200)
    ).body.data;
    expect(changed).toMatchObject({ partNumber: 'PN-NEW', sku: 'PATCH-SKU' });
    // leaving the field out keeps it
    const kept = (
      await alice.patch(`/products/${p.id}`, { name: 'Patched' }).expect(200)
    ).body.data;
    expect(kept.partNumber).toBe('PN-NEW');
    const cleared = (
      await alice.patch(`/products/${p.id}`, { partNumber: null }).expect(200)
    ).body.data;
    expect(cleared.partNumber).toBeNull();
    expect(cleared.sku).toBe('PATCH-SKU');
  });

  it('rejects a part number longer than 64 characters', async () => {
    const res = await alice
      .post('/products', {
        name: 'Too long',
        price: '1',
        partNumber: 'x'.repeat(65),
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/Part number/);
  });

  it('is kept with variants (the SKU is not)', async () => {
    const p = await create({
      name: 'Variants with part number',
      sku: 'IGNORED-SKU',
      partNumber: 'VAR-PN',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { options: { Size: 'S' }, price: '10', quantity: 1 },
        { options: { Size: 'M' }, price: '10', quantity: 1 },
      ],
    });
    expect(p.partNumber).toBe('VAR-PN');
    expect(p.sku).toBeNull();
  });

  it('is copied when a product is duplicated (the SKU is not)', async () => {
    const p = await create({
      name: 'Duplicate me',
      sku: 'DUPE-SKU',
      partNumber: 'DUPE-PN',
    });
    const copy = (
      await alice.post(`/products/${p.id}/duplicate`, {}).expect(201)
    ).body.data;
    expect(copy.partNumber).toBe('DUPE-PN');
    expect(copy.sku).toBeNull();
    expect(copy.id).not.toBe(p.id);
  });

  it('is imported from the part_number column, never used to match or conflict with other products', async () => {
    await create({ name: 'Existing PN', partNumber: 'IMP-PN' });
    const res = await alice
      .post('/products/import', {
        rows: [
          { row: 2, name: 'Imported one', price: '5', part_number: 'IMP-PN' },
          { row: 3, name: 'Imported two', price: '5', part_number: 'IMP-PN' },
          { row: 4, name: 'Imported three', price: '5' },
        ],
      })
      .expect(201);
    expect(res.body.data).toEqual({ count: 3 });
    const found = (await alice.get('/products?search=IMP-PN').expect(200)).body
      .data as { partNumber: string }[];
    expect(found).toHaveLength(3);
  });

  it('is shown on the public product page (null when absent), and only for active products', async () => {
    const withPn = await create({
      name: 'Public with PN',
      partNumber: 'PUB-PN-1',
    });
    const without = await create({ name: 'Public without PN' });
    const a = await anonymous(t)
      .get(`/public/storefronts/alpha-shop/products/${withPn.slug}`)
      .expect(200);
    expect(a.body.data.product).toMatchObject({
      part_number: 'PUB-PN-1',
      name: 'Public with PN',
    });
    const b = await anonymous(t)
      .get(`/public/storefronts/alpha-shop/products/${without.slug}`)
      .expect(200);
    expect(b.body.data.product.part_number).toBeNull();
    const draft = await create({
      name: 'Public draft PN',
      partNumber: 'PUB-PN-2',
      status: 'draft',
    });
    await anonymous(t)
      .get(`/public/storefronts/alpha-shop/products/${draft.slug}`)
      .expect(404);
  });
});
