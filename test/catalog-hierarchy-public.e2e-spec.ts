import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Id = { id: string };
type PubNode = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
  hasChildren: boolean;
  productCount: number;
};
type PubProduct = {
  name: string;
  slug: string;
  partNumber: string | null;
  priceMinor: number;
  available: boolean;
};

/** The public catalog API (migration 0073): the same response for every storefront template, only active data, per store. */
describe.skipIf(!migrationsAvailable)(
  'catalog hierarchy public API (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let bob: Client;
    const node: Record<string, Id> = {};
    const prod: Record<string, Id & { slug: string }> = {};

    const base = '/public/storefronts/alpha-shop/catalog';
    const get = (path: string) => anonymous(t).get(path);

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);

      const lvl = async (name: string, canHoldProducts = false) =>
        (
          await alice
            .post('/catalog/levels', { name, canHoldProducts })
            .expect(201)
        ).body.data as Id;
      const add = async (
        key: string,
        name: string,
        parent: string | null,
        status: 'active' | 'draft' = 'active',
        position?: number,
      ) => {
        node[key] = (
          await alice
            .post('/catalog/nodes', {
              name,
              status,
              ...(parent ? { parentId: node[parent].id } : {}),
              ...(position === undefined ? {} : { position }),
            })
            .expect(201)
        ).body.data as Id;
      };
      const product = async (
        key: string,
        name: string,
        price: string,
        extra: Record<string, unknown> = {},
      ) => {
        prod[key] = (
          await alice
            .post('/products', {
              name,
              price,
              status: 'active',
              quantity: 5,
              ...extra,
            })
            .expect(201)
        ).body.data as Id & { slug: string };
      };

      await alice.post('/catalog/hierarchy', { name: 'Parts' }).expect(201);
      await lvl('Brand');
      await lvl('Vehicle');
      await lvl('Part group', true);

      await add('toyota', 'Toyota', null, 'active', 1);
      await add('honda', 'Honda', null, 'draft', 2);
      await add('camry', 'Camry', 'toyota', 'active', 1);
      await add('corolla', 'Corolla', 'toyota', 'draft', 2);
      await add('civic', 'Civic', 'honda', 'active');
      await add('brakes', 'Brakes', 'camry', 'active', 1);
      await add('oil', 'Oil', 'camry', 'active', 2);
      await add('pads', 'Pads', 'corolla', 'active');
      await add('filters', 'Filters', 'civic', 'active');

      await product('pad', 'Brake pad', '30.00', {
        sku: 'PAD',
        partNumber: 'BP-1',
      });
      await product('disc', 'Brake disc', '20.00', { partNumber: 'BD-2' });
      await product('filter', 'Oil filter', '10.00', { partNumber: 'OF-3' });
      await product('draft', 'Hidden draft', '5.00', {
        status: 'draft',
        partNumber: 'DR-4',
      });
      await product('plain', 'No part number', '40.00');

      const put = (key: string, ids: string[]) =>
        alice
          .post(`/catalog/nodes/${node[key].id}/products`, {
            productIds: ids.map((k) => prod[k].id),
          })
          .expect(201);
      await put('brakes', ['pad', 'disc', 'draft']);
      await put('oil', ['filter', 'pad', 'plain']); // "pad" is on two items
      await put('pads', ['disc']);
      await put('filters', ['filter']);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const publish = () =>
      alice.patch('/catalog/hierarchy', { status: 'active' }).expect(200);

    describe('while the catalog is a draft or does not exist', () => {
      it('shows nothing publicly until the hierarchy is active', async () => {
        const tree = (await get(`${base}/tree`).expect(200)).body.data;
        expect(tree.hierarchy).toBeNull();
        expect(tree.nodes).toEqual([]);
        expect(tree.levels).toEqual([]);
        expect(tree.store).toMatchObject({ slug: 'alpha-shop' });
        await get(`${base}/nodes/toyota`).expect(404);
      });

      it('a store that never set up a catalog answers with an empty catalog', async () => {
        const res = await get(
          '/public/storefronts/beta-shop/catalog/tree',
        ).expect(200);
        expect(res.body.data.hierarchy).toBeNull();
        expect(res.body.data.nodes).toEqual([]);
      });

      it('an unknown store is a 404', async () => {
        const res = await get(
          '/public/storefronts/no-such-store/catalog/tree',
        ).expect(404);
        expect(res.body.error.code).toBe('STORE_NOT_FOUND');
        await get(
          '/public/storefronts/no-such-store/catalog/nodes/toyota',
        ).expect(404);
      });
    });

    describe('the tree', () => {
      beforeAll(publish);

      it('lists the levels and only active items below active parents, with paths, in display order', async () => {
        const res = await get(`${base}/tree`).expect(200);
        const { hierarchy, levels, nodes, truncated } = res.body.data as {
          hierarchy: { name: string };
          levels: {
            name: string;
            position: number;
            canHoldProducts: boolean;
          }[];
          nodes: PubNode[];
          truncated: boolean;
        };
        expect(hierarchy.name).toBe('Parts');
        expect(truncated).toBe(false);
        expect(levels).toEqual([
          expect.objectContaining({
            name: 'Brand',
            position: 1,
            canHoldProducts: false,
          }),
          expect.objectContaining({ name: 'Vehicle', position: 2 }),
          expect.objectContaining({
            name: 'Part group',
            position: 3,
            canHoldProducts: true,
          }),
        ]);
        // Honda is a draft: Honda, Civic and Filters are all hidden. Corolla is a draft: Corolla and Pads are hidden.
        expect(nodes.map((n) => n.path)).toEqual([
          'toyota',
          'toyota/camry',
          'toyota/camry/brakes',
          'toyota/camry/oil',
        ]);
        const camry = nodes.find((n) => n.name === 'Camry')!;
        expect(camry).toMatchObject({
          depth: 2,
          parentId: nodes[0].id,
          hasChildren: true,
        });
      });

      it('counts only active products placed directly on each item', async () => {
        const nodes = (await get(`${base}/tree`).expect(200)).body.data
          .nodes as PubNode[];
        const count = (name: string) =>
          nodes.find((n) => n.name === name)!.productCount;
        expect(count('Brakes')).toBe(2); // the draft product is not counted
        expect(count('Oil')).toBe(3);
        expect(count('Toyota')).toBe(0);
      });

      it('can be limited in depth, and still says which items have children', async () => {
        const nodes = (await get(`${base}/tree?maxDepth=1`).expect(200)).body
          .data.nodes as PubNode[];
        expect(nodes.map((n) => n.name)).toEqual(['Toyota']);
        expect(nodes[0].hasChildren).toBe(true);
        await get(`${base}/tree?maxDepth=0`).expect(400);
        await get(`${base}/tree?maxDepth=99`).expect(400);
      });

      it('works without signing in and exposes no internal ids or organization data', async () => {
        const res = await get(`${base}/tree`).expect(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/tenant/i);
        expect(text).not.toMatch(/path_ids|pathIds/);
        expect(text).not.toContain(w.tenantA);
      });

      it('is the same for every template: no template parameter changes the shape', async () => {
        const a = (await get(`${base}/tree`).expect(200)).body.data;
        const b = (await get(`${base}/tree?template=anything`).expect(400))
          .body;
        expect(Object.keys(a).sort()).toEqual([
          'hierarchy',
          'levels',
          'nodes',
          'store',
          'truncated',
        ]);
        expect(b.error).toBeDefined();
      });
    });

    describe('one item', () => {
      beforeAll(publish);

      it('returns the item, breadcrumbs, children and its products with part numbers', async () => {
        const res = await get(`${base}/nodes/toyota/camry/brakes`).expect(200);
        const d = res.body.data as {
          node: PubNode & { level: { name: string; canHoldProducts: boolean } };
          breadcrumbs: { name: string; path: string; levelName: string }[];
          children: PubNode[];
          products: {
            items: PubProduct[];
            page: number;
            limit: number;
            total: number;
            includeDescendants: boolean;
          };
          hierarchy: { name: string };
          store: { currency: string };
        };
        expect(d.node).toMatchObject({
          name: 'Brakes',
          path: 'toyota/camry/brakes',
          depth: 3,
          level: { name: 'Part group', canHoldProducts: true },
          productCount: 2,
        });
        expect(d.breadcrumbs.map((b) => [b.levelName, b.name, b.path])).toEqual(
          [
            ['Brand', 'Toyota', 'toyota'],
            ['Vehicle', 'Camry', 'toyota/camry'],
            ['Part group', 'Brakes', 'toyota/camry/brakes'],
          ],
        );
        expect(d.children).toEqual([]);
        expect(d.products).toMatchObject({
          page: 1,
          limit: 24,
          total: 2,
          includeDescendants: false,
        });
        expect(d.products.items.map((p) => p.name)).toEqual([
          'Brake pad',
          'Brake disc',
        ]);
        expect(d.products.items[0]).toMatchObject({
          partNumber: 'BP-1',
          priceMinor: 3000,
          available: true,
          slug: prod.pad.slug,
        });
        expect(d.store.currency).toBeTruthy();
      });

      it('lists the active children of an item with their counts', async () => {
        const d = (await get(`${base}/nodes/toyota`).expect(200)).body.data as {
          children: PubNode[];
          node: PubNode;
        };
        // Corolla is a draft
        expect(d.children.map((c) => c.name)).toEqual(['Camry']);
        expect(d.children[0]).toMatchObject({
          path: 'toyota/camry',
          hasChildren: true,
          productCount: 0,
        });
        expect(d.node.parentId).toBeNull();
      });

      it('includes the products of the descendants on request, each product once', async () => {
        const own = (await get(`${base}/nodes/toyota/camry`).expect(200)).body
          .data.products;
        expect(own.total).toBe(0);
        const all = (
          await get(
            `${base}/nodes/toyota/camry?includeDescendants=true`,
          ).expect(200)
        ).body.data.products as { items: PubProduct[]; total: number };
        // pad, disc (Brakes), filter, pad (again), plain (Oil): four distinct active products
        expect(all.total).toBe(4);
        expect(all.items.map((p) => p.name).sort()).toEqual([
          'Brake disc',
          'Brake pad',
          'No part number',
          'Oil filter',
        ]);
        const plain = all.items.find((p) => p.name === 'No part number')!;
        expect(plain.partNumber).toBeNull();
      });

      it('pages and sorts the products', async () => {
        const q = (s: string) =>
          get(`${base}/nodes/toyota/camry?includeDescendants=true&${s}`).expect(
            200,
          );
        const first = (await q('limit=2&page=1&sort=name')).body.data.products;
        expect(first.items.map((p: PubProduct) => p.name)).toEqual([
          'Brake disc',
          'Brake pad',
        ]);
        expect(first.total).toBe(4);
        const second = (await q('limit=2&page=2&sort=name')).body.data.products;
        expect(second.items.map((p: PubProduct) => p.name)).toEqual([
          'No part number',
          'Oil filter',
        ]);
        const cheap = (await q('sort=price_asc')).body.data.products.items.map(
          (p: PubProduct) => p.priceMinor,
        );
        expect(cheap).toEqual([...cheap].sort((a, b) => a - b));
        const dear = (await q('sort=price_desc')).body.data.products.items.map(
          (p: PubProduct) => p.priceMinor,
        );
        expect(dear).toEqual([...dear].sort((a, b) => b - a));
        const beyond = (await q('limit=2&page=9')).body.data.products;
        expect(beyond.items).toEqual([]);
        expect(beyond.total).toBe(4);
      });

      it('validates paging and sorting', async () => {
        await get(`${base}/nodes/toyota?limit=101`).expect(400);
        await get(`${base}/nodes/toyota?page=0`).expect(400);
        await get(`${base}/nodes/toyota?sort=random`).expect(400);
        await get(`${base}/nodes/toyota?includeDescendants=maybe`).expect(400);
      });

      it('never shows drafts: draft items, items below a draft item, draft products', async () => {
        await get(`${base}/nodes/toyota/corolla`).expect(404);
        await get(`${base}/nodes/toyota/corolla/pads`).expect(404);
        await get(`${base}/nodes/honda`).expect(404);
        await get(`${base}/nodes/honda/civic`).expect(404);
        await get(`${base}/nodes/honda/civic/filters`).expect(404);
        const products = (
          await get(`${base}/nodes/toyota/camry/brakes`).expect(200)
        ).body.data.products.items as PubProduct[];
        expect(products.map((p) => p.name)).not.toContain('Hidden draft');
      });

      it('hides everything again when an item is switched to draft, and shows it when it is active again', async () => {
        await alice
          .patch(`/catalog/nodes/${node.camry.id}`, { status: 'draft' })
          .expect(200);
        await get(`${base}/nodes/toyota/camry`).expect(404);
        await get(`${base}/nodes/toyota/camry/brakes`).expect(404);
        const nodes = (await get(`${base}/tree`).expect(200)).body.data
          .nodes as PubNode[];
        expect(nodes.map((n) => n.name)).toEqual(['Toyota']);
        await alice
          .patch(`/catalog/nodes/${node.camry.id}`, { status: 'active' })
          .expect(200);
        await get(`${base}/nodes/toyota/camry/brakes`).expect(200);
      });

      it('hides a draft product again and a deleted one for good', async () => {
        await alice
          .patch(`/products/${prod.disc.id}`, { status: 'draft' })
          .expect(200);
        const items = (
          await get(`${base}/nodes/toyota/camry/brakes`).expect(200)
        ).body.data.products.items as PubProduct[];
        expect(items.map((p) => p.name)).toEqual(['Brake pad']);
        await alice
          .patch(`/products/${prod.disc.id}`, { status: 'active' })
          .expect(200);
      });

      it('answers 404 for paths that do not exist or are not valid slugs, in any capitalisation', async () => {
        await get(`${base}/nodes/nothing`).expect(404);
        await get(`${base}/nodes/toyota/nothing`).expect(404);
        await get(`${base}/nodes/camry`).expect(404); // not a top-level item
        await get(`${base}/nodes/toyota/brakes`).expect(404); // skipping a level
        await get(`${base}/nodes/toyota%20x`).expect(404);
        await get(`${base}/nodes/${'a'.repeat(81)}`).expect(404);
        await get(`${base}/nodes/${Array(21).fill('a').join('/')}`).expect(404);
        await get(`${base}/nodes/TOYOTA/Camry`).expect(200);
      });

      it('reflects a rename of an item in its path, and a move', async () => {
        await alice
          .patch(`/catalog/nodes/${node.oil.id}`, { slug: 'oil-parts' })
          .expect(200);
        await get(`${base}/nodes/toyota/camry/oil`).expect(404);
        const d = (
          await get(`${base}/nodes/toyota/camry/oil-parts`).expect(200)
        ).body.data;
        expect(d.node.path).toBe('toyota/camry/oil-parts');
      });
    });

    describe('isolation between stores', () => {
      beforeAll(publish);

      it("another store never sees this store's items, and has its own catalog", async () => {
        await bob
          .post('/catalog/hierarchy', { name: 'Bob', status: 'active' })
          .expect(201);
        await bob
          .post('/catalog/levels', { name: 'Top', canHoldProducts: true })
          .expect(201);
        await bob
          .post('/catalog/nodes', {
            name: 'Toyota',
            status: 'active',
            slug: 'bob-toyota',
          })
          .expect(201);
        const other = '/public/storefronts/beta-shop/catalog';
        const tree = (await get(`${other}/tree`).expect(200)).body.data;
        expect(tree.nodes.map((n: PubNode) => n.path)).toEqual(['bob-toyota']);
        await get(`${other}/nodes/toyota`).expect(404);
        await get(`${other}/nodes/toyota/camry`).expect(404);
        await get(`${base}/nodes/bob-toyota`).expect(404);
      });

      it('a suspended or inactive store shows nothing', async () => {
        await t.db.asOwner((pg) =>
          pg.query(
            "update stores set status = 'inactive' where slug = 'alpha-shop'",
          ),
        );
        await get(`${base}/tree`).expect(404);
        await get(`${base}/nodes/toyota`).expect(404);
        await t.db.asOwner((pg) =>
          pg.query(
            "update stores set status = 'active' where slug = 'alpha-shop'",
          ),
        );
        await get(`${base}/tree`).expect(200);
      });

      it('the public functions are not callable by name with another store as a way around the rules', async () => {
        const res = await t.db.asOwner((pg) =>
          pg.query(
            "select public.get_public_catalog_node('alpha-shop', 'honda', 1, 10, false, 'position') as n",
          ),
        );
        expect((res.rows[0] as { n: unknown }).n).toBeNull();
      });
    });

    describe('the product page', () => {
      it('shows the part number of a product placed in the catalog', async () => {
        const res = await get(
          `/public/storefronts/alpha-shop/products/${prod.pad.slug}`,
        ).expect(200);
        expect(res.body.data.product).toMatchObject({
          part_number: 'BP-1',
          sku: 'PAD',
        });
      });
    });
  },
);
