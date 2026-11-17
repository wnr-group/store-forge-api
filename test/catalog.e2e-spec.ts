import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { insertOrder, seedWorld, type World } from './support/world.js';

/** Catalog, inventory, customers and analytics business rules against the real schema. */
describe.skipIf(!migrationsAvailable)(
  'catalog, inventory, customers and analytics (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('categories', () => {
      it('creates with a generated slug, lists with product counts and parent names', async () => {
        const parent = (
          await alice.post('/categories', { name: 'Summer Wear' }).expect(201)
        ).body.data;
        expect(parent.slug).toBe('summer-wear');
        const child = (
          await alice
            .post('/categories', { name: 'Tees', parentId: parent.id })
            .expect(201)
        ).body.data;
        expect(child).toMatchObject({
          parentId: parent.id,
          parentName: 'Summer Wear',
          productCount: 0,
        });
        const list = (await alice.get('/categories').expect(200)).body.data;
        expect(list.map((c: { name: string }) => c.name)).toEqual([
          'Summer Wear',
          'Tees',
        ]);
      });

      it('refuses a duplicate slug (409) and a cycle (400)', async () => {
        const dup = await alice
          .post('/categories', { name: 'Another', slug: 'summer-wear' })
          .expect(409);
        expect(dup.body.error).toMatchObject({
          code: 'CATEGORY_SLUG_TAKEN',
          details: { slug: 'This slug is already in use.' },
        });
        const [parent, child] = (await alice.get('/categories').expect(200))
          .body.data;
        const self = await alice
          .patch(`/categories/${parent.id}`, { parentId: parent.id })
          .expect(400);
        expect(self.body.error.code).toBe('CATEGORY_CYCLE');
        const loop = await alice
          .patch(`/categories/${parent.id}`, { parentId: child.id })
          .expect(400);
        expect(loop.body.error.code).toBe('CATEGORY_CYCLE');
      });

      it('deleting a parent turns its children into top-level categories', async () => {
        const [parent, child] = (await alice.get('/categories').expect(200))
          .body.data;
        await alice.delete(`/categories/${parent.id}`).expect(200);
        const after = await alice.get(`/categories/${child.id}`).expect(200);
        expect(after.body.data.parentId).toBeNull();
        await alice.get(`/categories/${parent.id}`).expect(404);
      });
    });

    describe('products', () => {
      let category: string;

      beforeAll(async () => {
        category = (
          await alice.post('/categories', { name: 'Shirts' }).expect(201)
        ).body.data.id;
      });

      it('creates a simple product: decimal text in, minor units out, unique slug generated', async () => {
        const res = await alice
          .post('/products', {
            name: 'Classic Tee',
            price: '1,299.50',
            compareAtPrice: '1599',
            sku: 'TEE-1',
            categoryId: category,
            quantity: 12,
            status: 'active',
          })
          .expect(201);
        expect(res.body.data).toMatchObject({
          slug: 'classic-tee',
          priceMinor: 129950,
          compareAtPriceMinor: 159900,
          sku: 'TEE-1',
          quantity: 12,
          status: 'active',
          hasVariants: false,
          categoryId: category,
        });
        const again = await alice
          .post('/products', { name: 'Classic Tee', price: '10' })
          .expect(201);
        expect(again.body.data.slug).toBe('classic-tee-2');
      });

      it('enforces unique SKUs per organization (409) and allows the same SKU in another organization', async () => {
        const dup = await alice
          .post('/products', { name: 'Other', price: '5', sku: 'TEE-1' })
          .expect(409);
        expect(dup.body.error).toMatchObject({
          code: 'SKU_TAKEN',
          details: { sku: 'This SKU is already in use.' },
        });
        await (
          await as(t, w.bob)
        )
          .post('/products', { name: 'Bob Tee', price: '5', sku: 'TEE-1' })
          .expect(201);
      });

      it("applies the store currency's decimals and the cross-field rules", async () => {
        const tooPrecise = await alice
          .post('/products', { name: 'Precise', price: '10.999' })
          .expect(400);
        expect(tooPrecise.body.error.code).toBe('INVALID_AMOUNT');
        const compare = await alice
          .post('/products', {
            name: 'Compare',
            price: '100',
            compareAtPrice: '100',
          })
          .expect(400);
        expect(compare.body.error.details).toMatchObject({
          compareAtPrice: 'Compare-at price must be greater than the price.',
        });
        await alice.post('/products', { name: 'Free', price: '0' }).expect(400);
        await alice
          .post('/products', { name: 'Negative', price: '-5' })
          .expect(400);
        await alice
          .post('/products', { name: 'Words', price: 'ten' })
          .expect(400);
      });

      it('creates a product with options and variants; stock lives on the variants', async () => {
        const res = await alice
          .post('/products', {
            name: 'Hoodie',
            price: '2000',
            sku: 'ignored-with-variants',
            quantity: 99,
            options: [{ name: 'Size', values: ['S', 'M'] }],
            variants: [
              {
                options: { Size: 'S' },
                price: '2000',
                quantity: 3,
                sku: 'HOOD-S',
              },
              {
                options: { Size: 'M' },
                price: '2100',
                quantity: 0,
                sku: 'HOOD-M',
              },
            ],
          })
          .expect(201);
        expect(res.body.data).toMatchObject({
          hasVariants: true,
          sku: null,
          quantity: 0,
        });
        expect(
          res.body.data.variants.map(
            (v: { title: string; priceMinor: number }) => [
              v.title,
              v.priceMinor,
            ],
          ),
        ).toEqual([
          ['S', 200000],
          ['M', 210000],
        ]);
        expect(res.body.data.options[0]).toMatchObject({
          name: 'Size',
          values: ['S', 'M'],
        });
      });

      it('rejects inconsistent variants', async () => {
        const wrongValue = await alice
          .post('/products', {
            name: 'Bad1',
            price: '5',
            options: [{ name: 'Size', values: ['S'] }],
            variants: [{ options: { Size: 'XL' }, price: '5', quantity: 1 }],
          })
          .expect(400);
        expect(wrongValue.body.error.code).toBe('INVALID_VARIANT');
        const dupCombo = await alice
          .post('/products', {
            name: 'Bad2',
            price: '5',
            options: [{ name: 'Size', values: ['S'] }],
            variants: [
              { options: { Size: 'S' }, price: '5', quantity: 1 },
              { options: { Size: 'S' }, price: '5', quantity: 1 },
            ],
          })
          .expect(400);
        expect(dupCombo.body.error.code).toBe('DUPLICATE_VARIANT');
        const noVariants = await alice
          .post('/products', {
            name: 'Bad3',
            price: '5',
            options: [{ name: 'Size', values: ['S'] }],
          })
          .expect(400);
        expect(noVariants.body.error.details).toMatchObject({
          variants: 'Generate at least one variant.',
        });
        const dupSku = await alice
          .post('/products', {
            name: 'Bad4',
            price: '5',
            sku: 'A',
            options: [{ name: 'Size', values: ['S', 'M'] }],
            variants: [
              { options: { Size: 'S' }, price: '5', quantity: 1, sku: 'DUP' },
              { options: { Size: 'M' }, price: '5', quantity: 1, sku: 'dup' },
            ],
          })
          .expect(400);
        expect(dupSku.body.error.details).toMatchObject({
          'variants.1.sku': 'This SKU is used more than once on this product.',
        });
      });

      it('verifies uploaded images against storage and makes the first one primary', async () => {
        const id = randomUUID();
        const path = `${w.tenantA}/${id}/${randomUUID()}.png`;
        const missing = await alice
          .post('/products', {
            id,
            name: 'With Image',
            price: '5',
            images: [{ path, altText: 'front' }],
          })
          .expect(400);
        expect(missing.body.message).toMatch(/did not finish/);
        t.storage.upload(path);
        const ok = await alice
          .post('/products', {
            id,
            name: 'With Image',
            price: '5',
            images: [{ path, altText: 'front' }],
          })
          .expect(201);
        expect(ok.body.data.images).toHaveLength(1);
        expect(ok.body.data.images[0]).toMatchObject({
          storagePath: path,
          isPrimary: true,
          altText: 'front',
          mimeType: 'image/png',
        });
        // A path under ANOTHER organization is refused even if it exists in storage.
        const foreign = `${w.tenantB}/${randomUUID()}/${randomUUID()}.png`;
        t.storage.upload(foreign);
        await alice
          .post('/products', {
            name: 'Foreign Image',
            price: '5',
            images: [{ path: foreign }],
          })
          .expect(400);
      });

      it('lists with search, filters, sort and pagination metadata', async () => {
        const all = await alice
          .get('/products?limit=2&page=1&sortBy=name&sortOrder=asc')
          .expect(200);
        expect(all.body.meta).toMatchObject({ page: 1, limit: 2 });
        expect(all.body.meta.total).toBeGreaterThanOrEqual(4);
        expect(all.body.meta.totalPages).toBe(
          Math.ceil(all.body.meta.total / 2),
        );
        expect(all.body.data).toHaveLength(2);
        const search = await alice.get('/products?search=hood').expect(200);
        expect(search.body.data.map((p: { name: string }) => p.name)).toEqual([
          'Hoodie',
        ]);
        expect(search.body.data[0]).toMatchObject({
          hasVariants: true,
          variantCount: 2,
          stock: 3,
        });
        const bySku = await alice.get('/products?search=TEE-1').expect(200);
        expect(bySku.body.data).toHaveLength(1);
        const literal = await alice.get('/products?search=%25').expect(200);
        expect(literal.body.data).toEqual([]); // % is matched literally, not as a wildcard
        const active = await alice.get('/products?status=active').expect(200);
        expect(
          active.body.data.every(
            (p: { status: string }) => p.status === 'active',
          ),
        ).toBe(true);
        const byCategory = await alice
          .get(`/products?category=${category}`)
          .expect(200);
        expect(
          byCategory.body.data.map((p: { name: string }) => p.name),
        ).toEqual(['Classic Tee']);
        const uncategorised = await alice
          .get('/products?category=none')
          .expect(200);
        expect(uncategorised.body.data.length).toBeGreaterThan(0);
        await alice.get('/products?limit=500').expect(400);
        await alice.get('/products?sortBy=password').expect(400);
      });

      it('stock filters use the effective stock (variant totals for products with variants)', async () => {
        const low = (
          await alice.get('/products?stock=low').expect(200)
        ).body.data.map((p: { name: string }) => p.name);
        expect(low).toContain('Hoodie'); // 3 <= threshold 5
        const out = (
          await alice.get('/products?stock=out').expect(200)
        ).body.data.map((p: { name: string }) => p.name);
        expect(out).not.toContain('Hoodie');
      });

      it('PATCH is partial: omitted fields (and the whole variant set) are kept', async () => {
        const [hoodie] = (await alice.get('/products?search=hood').expect(200))
          .body.data;
        const res = await alice
          .patch(`/products/${hoodie.id}`, {
            name: 'Hoodie 2',
            status: 'active',
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          name: 'Hoodie 2',
          status: 'active',
          slug: 'hoodie',
          hasVariants: true,
        });
        expect(res.body.data.variants).toHaveLength(2);
        expect(res.body.data.variants[0].priceMinor).toBe(200000);
      });

      it('PATCH replaces variants when sent, keeping ids of surviving ones and dropping the rest', async () => {
        const [hoodie] = (await alice.get('/products?search=hood').expect(200))
          .body.data;
        const detail = (await alice.get(`/products/${hoodie.id}`).expect(200))
          .body.data;
        const keep = detail.variants[0];
        const res = await alice
          .patch(`/products/${hoodie.id}`, {
            variants: [
              {
                id: keep.id,
                options: keep.options,
                price: '2500',
                quantity: 7,
                sku: keep.sku,
              },
            ],
          })
          .expect(200)
          .catch(() => null);
        // options still declare S and M, so a lone S variant is valid
        expect(res?.body.data.variants).toHaveLength(1);
        expect(res?.body.data.variants[0]).toMatchObject({
          id: keep.id,
          priceMinor: 250000,
          quantity: 7,
        });
      });

      it('PATCH validates the merged result like a create', async () => {
        const [tee] = (await alice.get('/products?search=TEE-1').expect(200))
          .body.data;
        const res = await alice
          .patch(`/products/${tee.id}`, { compareAtPrice: '1000' })
          .expect(400); // price is 1299.50
        expect(res.body.error.details).toMatchObject({
          compareAtPrice: 'Compare-at price must be greater than the price.',
        });
        const ok = await alice
          .patch(`/products/${tee.id}`, { compareAtPrice: null, cost: '400' })
          .expect(200);
        expect(ok.body.data).toMatchObject({
          compareAtPriceMinor: null,
          costMinor: 40000,
          priceMinor: 129950,
        });
      });

      it('duplicates as a draft with a fresh slug and no SKU', async () => {
        const [tee] = (await alice.get('/products?search=TEE-1').expect(200))
          .body.data;
        const copy = await alice
          .post(`/products/${tee.id}/duplicate`)
          .expect(201);
        expect(copy.body.data).toMatchObject({
          name: 'Classic Tee (copy)',
          status: 'draft',
          sku: null,
          slug: 'classic-tee-copy',
        });
        expect(copy.body.data.images).toEqual([]);
      });

      it('bulk status and bulk delete report how many rows they touched', async () => {
        const ids = (
          await alice.get('/products?search=copy').expect(200)
        ).body.data.map((p: { id: string }) => p.id);
        const status = await alice
          .post('/products/bulk-status', { ids, status: 'active' })
          .expect(200);
        expect(status.body.data.count).toBe(ids.length);
        const del = await alice
          .post('/products/bulk-delete', { ids: [...ids, randomUUID()] })
          .expect(200);
        expect(del.body.data.count).toBe(ids.length);
        await alice.post('/products/bulk-delete', { ids: [] }).expect(400);
      });

      it('deleting a product removes its image files once nothing references them', async () => {
        const [withImage] = (
          await alice.get('/products?search=With Image').expect(200)
        ).body.data;
        const detail = (
          await alice.get(`/products/${withImage.id}`).expect(200)
        ).body.data;
        const path = detail.images[0].storagePath;
        expect(t.storage.objects.has(path)).toBe(true);
        await alice.delete(`/products/${withImage.id}`).expect(200);
        expect(t.storage.removed).toContain(path);
        await alice.get(`/products/${withImage.id}`).expect(404);
        await alice.delete(`/products/${withImage.id}`).expect(404);
      });
    });

    describe('collections', () => {
      it('creates with ordered products and lists with counts', async () => {
        const products = (
          await alice.get('/collections/product-options').expect(200)
        ).body.data;
        expect(products.length).toBeGreaterThan(1);
        const ids = products.slice(0, 2).map((p: { id: string }) => p.id);
        const created = await alice
          .post('/collections', {
            name: 'Best Sellers',
            status: 'active',
            productIds: ids,
          })
          .expect(201);
        expect(created.body.data).toMatchObject({
          slug: 'best-sellers',
          status: 'active',
          productCount: 2,
          productIds: ids,
        });
        const list = await alice.get('/collections').expect(200);
        expect(list.body.data[0]).toMatchObject({
          name: 'Best Sellers',
          productCount: 2,
        });
      });

      it('replaces the product list on PATCH only when sent, and rejects duplicate slugs', async () => {
        const [c] = (await alice.get('/collections').expect(200)).body.data;
        const renamed = await alice
          .patch(`/collections/${c.id}`, { name: 'Top Sellers' })
          .expect(200);
        expect(renamed.body.data).toMatchObject({
          name: 'Top Sellers',
          productCount: 2,
        });
        const cleared = await alice
          .patch(`/collections/${c.id}`, { productIds: [] })
          .expect(200);
        expect(cleared.body.data.productCount).toBe(0);
        await alice
          .post('/collections', { name: 'Other', slug: 'best-sellers' })
          .expect(409);
      });

      it('verifies the collection image and removes the old file after a replacement', async () => {
        const id = randomUUID();
        const first = `${w.tenantA}/collections/${id}/${randomUUID()}.png`;
        const second = `${w.tenantA}/collections/${id}/${randomUUID()}.png`;
        t.storage.upload(first);
        t.storage.upload(second);
        await alice
          .post('/collections', { id, name: 'Imaged', imagePath: first })
          .expect(201);
        const updated = await alice
          .patch(`/collections/${id}`, { imagePath: second })
          .expect(200);
        expect(updated.body.data.imagePath).toBe(second);
        expect(t.storage.removed).toContain(first);
        await alice.delete(`/collections/${id}`).expect(200);
        expect(t.storage.removed).toContain(second);
      });
    });

    describe('inventory', () => {
      let simple: string;
      let hoodie: { id: string; variantId: string };

      beforeAll(async () => {
        simple = (
          await alice
            .post('/products', {
              name: 'Stock Item',
              price: '50',
              quantity: 4,
              lowStockThreshold: 5,
            })
            .expect(201)
        ).body.data.id;
        const h = (await alice.get('/products?search=hood').expect(200)).body
          .data[0];
        const detail = (await alice.get(`/products/${h.id}`).expect(200)).body
          .data;
        hoodie = { id: h.id, variantId: detail.variants[0].id };
      });

      it('lists one row per sellable unit, out-of-stock first', async () => {
        const list = await alice.get('/inventory').expect(200);
        const names = list.body.data.map(
          (r: { productName: string; variantTitle: string | null }) =>
            `${r.productName}${r.variantTitle ? ` / ${r.variantTitle}` : ''}`,
        );
        expect(names).toContain('Stock Item');
        expect(names).toContain('Hoodie 2 / S');
        expect(list.body.data[0].state).toMatch(/out|low/);
        const low = await alice.get('/inventory?stock=low').expect(200);
        expect(
          low.body.data.every((r: { state: string }) => r.state === 'low'),
        ).toBe(true);
      });

      it('adds and sets stock, writing an append-only ledger row each time', async () => {
        const added = await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'add',
            value: 6,
            reason: 'restock',
            note: 'delivery',
          })
          .expect(201);
        expect(added.body.data.quantity).toBe(10);
        const set = await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'set',
            value: 2,
            reason: 'correction',
          })
          .expect(201);
        expect(set.body.data.quantity).toBe(2);
        const ledger = (
          await alice.get('/inventory/adjustments?limit=2').expect(200)
        ).body.data;
        expect(ledger[0]).toMatchObject({
          productId: simple,
          delta: -8,
          quantityAfter: 2,
          reason: 'correction',
          createdBy: w.alice,
        });
        expect(ledger[1]).toMatchObject({
          delta: 6,
          quantityAfter: 10,
          note: 'delivery',
        });
      });

      it('never lets stock go negative and refuses no-op or malformed adjustments', async () => {
        const below = await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'add',
            value: -3,
            reason: 'damage',
          })
          .expect(400);
        expect(below.body.error.code).toBe('NEGATIVE_STOCK');
        await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'set',
            value: -1,
            reason: 'correction',
          })
          .expect(400);
        await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'add',
            value: 0,
            reason: 'other',
          })
          .expect(400);
        const same = await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'set',
            value: 2,
            reason: 'correction',
          })
          .expect(400);
        expect(same.body.error.code).toBe('NO_CHANGE');
        await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'add',
            value: 1.5,
            reason: 'other',
          })
          .expect(400);
        await alice
          .post('/inventory/adjustments', {
            productId: simple,
            mode: 'add',
            value: 1,
            reason: 'theft',
          })
          .expect(400);
        const after = (await alice.get(`/products/${simple}`).expect(200)).body
          .data;
        expect(after.quantity).toBe(2);
      });

      it('requires a variant exactly when the product has variants', async () => {
        const missing = await alice
          .post('/inventory/adjustments', {
            productId: hoodie.id,
            mode: 'add',
            value: 1,
            reason: 'restock',
          })
          .expect(400);
        expect(missing.body.error.code).toBe('VARIANT_REQUIRED');
        const extra = await alice
          .post('/inventory/adjustments', {
            productId: simple,
            variantId: hoodie.variantId,
            mode: 'add',
            value: 1,
            reason: 'restock',
          })
          .expect(400);
        expect(extra.body.error.code).toBe('NO_VARIANTS');
        const ok = await alice
          .post('/inventory/adjustments', {
            productId: hoodie.id,
            variantId: hoodie.variantId,
            mode: 'add',
            value: 5,
            reason: 'restock',
          })
          .expect(201);
        expect(ok.body.data.quantity).toBe(12); // variant had 7 after the PATCH test
      });

      it('refuses untracked products', async () => {
        const untracked = (
          await alice
            .post('/products', {
              name: 'Untracked',
              price: '5',
              trackInventory: false,
            })
            .expect(201)
        ).body.data.id;
        const res = await alice
          .post('/inventory/adjustments', {
            productId: untracked,
            mode: 'add',
            value: 1,
            reason: 'restock',
          })
          .expect(400);
        expect(res.body.error.code).toBe('INVENTORY_NOT_TRACKED');
      });

      it('serialises concurrent adjustments so no update is lost', async () => {
        const id = (
          await alice
            .post('/products', { name: 'Race', price: '5', quantity: 0 })
            .expect(201)
        ).body.data.id;
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            alice.post('/inventory/adjustments', {
              productId: id,
              mode: 'add',
              value: 1,
              reason: 'restock',
            }),
          ),
        );
        expect(results.every((r) => r.status === 201)).toBe(true);
        expect(
          (await alice.get(`/products/${id}`).expect(200)).body.data.quantity,
        ).toBe(5);
      });
    });

    describe('customers', () => {
      let customer: string;

      it('creates, normalises the email and refuses case-insensitive duplicates', async () => {
        const res = await alice
          .post('/customers', {
            fullName: '  Dana Shopper ',
            email: ' Dana@Example.TEST ',
            phone: '+1 415 555 0100',
            notes: '',
          })
          .expect(201);
        customer = res.body.data.id;
        expect(res.body.data).toMatchObject({
          fullName: 'Dana Shopper',
          email: 'dana@example.test',
          notes: null,
          orderCount: 0,
          totalSpentMinor: 0,
          lastOrderAt: null,
        });
        const dup = await alice
          .post('/customers', { fullName: 'Other', email: 'DANA@example.test' })
          .expect(409);
        expect(dup.body.error).toMatchObject({
          code: 'CUSTOMER_EMAIL_TAKEN',
          details: {
            email: 'A customer with this email address already exists.',
          },
        });
      });

      it('validates phone and email', async () => {
        await alice
          .post('/customers', { fullName: 'X', email: 'not-an-email' })
          .expect(400);
        await alice
          .post('/customers', {
            fullName: 'X',
            email: 'x@y.test',
            phone: 'abc',
          })
          .expect(400);
        await alice
          .post('/customers', { fullName: '', email: 'x@y.test' })
          .expect(400);
      });

      it('computes order counts and spend from real orders (paid + fulfilled only)', async () => {
        await insertOrder(t.db, w.tenantA, customer, 1, 'paid', 10000);
        await insertOrder(t.db, w.tenantA, customer, 2, 'fulfilled', 5000);
        await insertOrder(t.db, w.tenantA, customer, 3, 'cancelled', 99999);
        await insertOrder(t.db, w.tenantA, customer, 4, 'pending', 777);
        const detail = (await alice.get(`/customers/${customer}`).expect(200))
          .body.data;
        expect(detail).toMatchObject({ orderCount: 4, totalSpentMinor: 15000 });
        expect(detail.orders).toHaveLength(4);
        expect(detail.orders[0].orderNumber).toBeGreaterThan(0);
        const sorted = await alice
          .get('/customers?sortBy=spent&sortOrder=desc')
          .expect(200);
        expect(sorted.body.data[0].id).toBe(customer);
        const search = await alice.get('/customers?search=shopper').expect(200);
        expect(search.body.meta.total).toBe(1);
      });

      it('deleting a customer keeps their orders', async () => {
        await alice.delete(`/customers/${customer}`).expect(200);
        const left = await t.db.asOwner((pg) =>
          pg.query(
            'select count(*)::int as n from orders where tenant_id = $1',
            [w.tenantA],
          ),
        );
        expect((left.rows[0] as { n: number }).n).toBe(4);
        await alice.get(`/customers/${customer}`).expect(404);
      });

      it('exposes no way to create, change or delete orders', async () => {
        await alice.post('/orders', {}).expect(404);
        await alice.get('/orders').expect(404);
      });
    });

    describe('analytics', () => {
      it('returns zero-filled series, revenue from paid + fulfilled orders only, and best sellers', async () => {
        await insertOrder(t.db, w.tenantA, null, 10, 'paid', 30000, [
          { name: 'Tee', quantity: 3, totalMinor: 30000 },
        ]);
        const res = await alice.get('/analytics?range=7').expect(200);
        const a = res.body.data;
        expect(a.range).toBe(7);
        expect(a.series).toHaveLength(7);
        expect(a.hasOrders).toBe(true);
        expect(a.totalSalesMinor).toBe(10000 + 5000 + 30000);
        expect(a.bestSellers[0]).toMatchObject({
          name: 'Tee',
          units: 3,
          salesMinor: 30000,
        });
        expect(a.recentOrders.length).toBeGreaterThan(0);
        expect(a.currency).toBe('INR');
        expect(
          a.series.reduce(
            (sum: number, p: { salesMinor: number }) => sum + p.salesMinor,
            0,
          ),
        ).toBe(a.totalSalesMinor);
      });

      it('reports an honest empty state for an organization without orders', async () => {
        const res = await (await as(t, w.bob)).get('/analytics').expect(200);
        expect(res.body.data).toMatchObject({
          range: 30,
          hasOrders: false,
          totalSalesMinor: 0,
          orders: 0,
          averageOrderMinor: 0,
        });
        expect(res.body.data.series).toHaveLength(30);
      });

      it('rejects ranges other than 7, 30 and 90', async () => {
        await alice.get('/analytics?range=14').expect(400);
      });

      it('does not mix organizations', async () => {
        const bob = (
          await (await as(t, w.bob)).get('/analytics?range=90').expect(200)
        ).body.data;
        expect(bob.totalSalesMinor).toBe(0);
      });
    });
  },
);
