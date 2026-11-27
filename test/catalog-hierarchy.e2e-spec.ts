import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Level = { id: string; name: string; position: number; nodeCount: number };
type Node = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  levelId: string;
  levelName: string;
  depth: number;
  pathIds: string[];
  childCount: number;
  productCount: number;
  status: string;
  position: number;
  path?: string;
  breadcrumbs?: { name: string; path: string }[];
};

/** The admin API of the catalog hierarchy: hierarchy, levels, items, moves, product placement, permissions, isolation. */
describe.skipIf(!migrationsAvailable)(
  'catalog hierarchy admin API (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let bob: Client;
    let reader: Client;
    let writer: Client;
    let noAccess: Client;
    const levels: Record<string, Level> = {};

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);
      reader = await as(t, w.members.reader);
      writer = await as(t, w.members.writer);
      noAccess = await as(t, w.members.nothing);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const addLevel = async (name: string, body: Record<string, unknown> = {}) =>
      (await alice.post('/catalog/levels', { name, ...body }).expect(201)).body
        .data as Level;
    const addNode = async (body: Record<string, unknown>, who = alice) =>
      (await who.post('/catalog/nodes', body).expect(201)).body.data as Node;
    const product = async (name: string, extra: Record<string, unknown> = {}) =>
      (
        await alice
          .post('/products', { name, price: '10', status: 'active', ...extra })
          .expect(201)
      ).body.data as { id: string; slug: string };

    describe('set-up', () => {
      it('answers 404 CATALOG_HIERARCHY_NOT_FOUND until the hierarchy exists', async () => {
        const res = await alice.get('/catalog/hierarchy').expect(404);
        expect(res.body.error.code).toBe('CATALOG_HIERARCHY_NOT_FOUND');
        await alice.get('/catalog/tree').expect(404);
        await alice.post('/catalog/levels', { name: 'Too early' }).expect(404);
      });

      it('creates the hierarchy as a draft; a second one is refused (one per organization for now)', async () => {
        const res = await alice
          .post('/catalog/hierarchy', { name: 'Parts catalog' })
          .expect(201);
        expect(res.body.data).toMatchObject({
          name: 'Parts catalog',
          status: 'draft',
          levels: [],
          nodeCount: 0,
        });
        const again = await alice
          .post('/catalog/hierarchy', { name: 'Second' })
          .expect(409);
        expect(again.body.error.code).toBe('CATALOG_HIERARCHY_EXISTS');
        // another organization has its own
        await bob
          .post('/catalog/hierarchy', { name: 'Bob catalog' })
          .expect(201);
      });

      it('renames the hierarchy and changes its status', async () => {
        const res = await alice
          .patch('/catalog/hierarchy', { name: 'Auto parts' })
          .expect(200);
        expect(res.body.data.name).toBe('Auto parts');
      });
    });

    describe('levels', () => {
      it('adds levels with custom names in order, appended by default', async () => {
        levels.brand = await addLevel('Brand');
        levels.vehicle = await addLevel('Vehicle');
        levels.variant = await addLevel('Variant');
        levels.part = await addLevel('Part category', {
          canHoldProducts: true,
        });
        expect([
          levels.brand.position,
          levels.vehicle.position,
          levels.variant.position,
          levels.part.position,
        ]).toEqual([1, 2, 3, 4]);
        const list = (await alice.get('/catalog/levels').expect(200)).body
          .data as Level[];
        expect(list.map((l) => l.name)).toEqual([
          'Brand',
          'Vehicle',
          'Variant',
          'Part category',
        ]);
      });

      it('refuses a level name that is already used (any capitalisation)', async () => {
        const res = await alice
          .post('/catalog/levels', { name: 'brand' })
          .expect(409);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_NAME_TAKEN');
      });

      it('renames a level; the items keep their place', async () => {
        const res = await alice
          .patch(`/catalog/levels/${levels.part.id}`, { name: 'Part group' })
          .expect(200);
        expect(res.body.data.name).toBe('Part group');
        levels.part.name = 'Part group';
      });

      it('limits the number of levels to 20', async () => {
        for (let i = 5; i <= 20; i++) await addLevel(`Extra ${i}`);
        const res = await alice
          .post('/catalog/levels', { name: 'One too many' })
          .expect(400);
        expect(res.body.error.code).toBe('CATALOG_TOO_MANY_LEVELS');
        const list = (await alice.get('/catalog/levels').expect(200)).body
          .data as Level[];
        for (const l of list.slice(4))
          await alice.delete(`/catalog/levels/${l.id}`).expect(200);
        expect(
          (
            (await alice.get('/catalog/levels').expect(200)).body
              .data as Level[]
          ).length,
        ).toBe(4);
      });
    });

    describe('items', () => {
      const n: Record<string, Node> = {};

      it('adds top-level items on level 1 and children one level below their parent', async () => {
        n.toyota = await addNode({ name: 'Toyota', status: 'active' });
        n.honda = await addNode({ name: 'Honda', status: 'active' });
        n.camry = await addNode({
          name: 'Camry',
          parentId: n.toyota.id,
          status: 'active',
        });
        n.le = await addNode({
          name: 'LE 2.5',
          parentId: n.camry.id,
          status: 'active',
        });
        expect(n.toyota).toMatchObject({
          depth: 1,
          levelName: 'Brand',
          slug: 'toyota',
          parentId: null,
        });
        expect(n.camry).toMatchObject({ depth: 2, levelName: 'Vehicle' });
        expect(n.le).toMatchObject({
          depth: 3,
          levelName: 'Variant',
          path: 'toyota/camry/le-2-5',
        });
        expect(n.le.pathIds).toEqual([n.toyota.id, n.camry.id, n.le.id]);
        expect(n.le.breadcrumbs?.map((b) => b.name)).toEqual([
          'Toyota',
          'Camry',
          'LE 2.5',
        ]);
      });

      it('makes slugs unique among siblings automatically, and refuses an explicit duplicate', async () => {
        const second = await addNode({ name: 'Toyota' });
        expect(second.slug).toBe('toyota-2');
        const third = await addNode({ name: 'Toyota' });
        expect(third.slug).toBe('toyota-3');
        const dup = await alice
          .post('/catalog/nodes', { name: 'X', slug: 'toyota' })
          .expect(409);
        expect(dup.body.error.code).toBe('CATALOG_NODE_SLUG_TAKEN');
        // the same slug under another parent is fine
        const c = await addNode({ name: 'Camry', parentId: n.honda.id });
        expect(c.slug).toBe('camry');
        await alice.delete(`/catalog/nodes/${second.id}`).expect(200);
        await alice.delete(`/catalog/nodes/${third.id}`).expect(200);
        await alice.delete(`/catalog/nodes/${c.id}`).expect(200);
      });

      it('refuses a child below the last level and a parent that does not exist', async () => {
        const part = await addNode({
          name: 'Brakes',
          parentId: n.le.id,
          status: 'active',
        });
        n.brakes = part;
        expect(part.levelName).toBe('Part group');
        const res = await alice
          .post('/catalog/nodes', { name: 'Too deep', parentId: part.id })
          .expect(400);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_MISSING');
        const ghost = await alice
          .post('/catalog/nodes', {
            name: 'Ghost',
            parentId: '00000000-0000-4000-8000-000000000000',
          })
          .expect(400);
        expect(ghost.body.error.code).toBe('CATALOG_PARENT_NOT_FOUND');
      });

      it('returns the nested tree, with counts, and a subtree', async () => {
        const tree = (await alice.get('/catalog/tree').expect(200)).body
          .data as {
          nodes: (Node & { children: (Node & { children: Node[] })[] })[];
          truncated: boolean;
        };
        expect(tree.truncated).toBe(false);
        expect(tree.nodes.map((x) => x.name).sort()).toEqual([
          'Honda',
          'Toyota',
        ]);
        const toyota = tree.nodes.find((x) => x.name === 'Toyota')!;
        expect(toyota.childCount).toBe(1);
        expect(toyota.children[0].name).toBe('Camry');
        expect(toyota.children[0].children[0].name).toBe('LE 2.5');
        const sub = (
          await alice.get(`/catalog/tree?parentId=${n.camry.id}`).expect(200)
        ).body.data.nodes as Node[];
        expect(sub).toHaveLength(1);
        expect(sub[0].name).toBe('Camry');
        const shallow = (
          await alice.get('/catalog/tree?maxDepth=1').expect(200)
        ).body.data.nodes as (Node & { children: unknown[] })[];
        expect(shallow.every((x) => x.children.length === 0)).toBe(true);
      });

      it('lists items flat with search, parent, level and status filters, paginated', async () => {
        const roots = await alice
          .get('/catalog/nodes?parentId=root')
          .expect(200);
        expect((roots.body.data as Node[]).map((x) => x.name).sort()).toEqual([
          'Honda',
          'Toyota',
        ]);
        expect(roots.body.meta.total).toBe(2);
        const found = (await alice.get('/catalog/nodes?search=cam').expect(200))
          .body.data as Node[];
        expect(found.map((x) => x.name)).toEqual(['Camry']);
        const byLevel = (
          await alice
            .get(`/catalog/nodes?levelId=${levels.variant.id}`)
            .expect(200)
        ).body.data as Node[];
        expect(byLevel.map((x) => x.name)).toEqual(['LE 2.5']);
        const page = await alice
          .get('/catalog/nodes?limit=1&page=2')
          .expect(200);
        expect(page.body.data).toHaveLength(1);
      });

      it('edits an item (and the slug)', async () => {
        const res = await alice
          .patch(`/catalog/nodes/${n.honda.id}`, {
            name: 'Honda Motors',
            description: 'Japan',
            seoTitle: 'Honda parts',
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          name: 'Honda Motors',
          description: 'Japan',
          seoTitle: 'Honda parts',
          slug: 'honda',
        });
        const clash = await alice
          .patch(`/catalog/nodes/${n.honda.id}`, { slug: 'toyota' })
          .expect(409);
        expect(clash.body.error.code).toBe('CATALOG_NODE_SLUG_TAKEN');
      });

      it('moves an item with everything below it, and keeps the paths right', async () => {
        const res = await alice
          .post(`/catalog/nodes/${n.camry.id}/move`, { parentId: n.honda.id })
          .expect(200);
        expect(res.body.data.path).toBe('honda/camry');
        const le = (await alice.get(`/catalog/nodes/${n.le.id}`).expect(200))
          .body.data as Node;
        expect(le.path).toBe('honda/camry/le-2-5');
        expect(le.pathIds).toEqual([n.honda.id, n.camry.id, n.le.id]);
        expect(le.depth).toBe(3);
        // and back
        await alice
          .post(`/catalog/nodes/${n.camry.id}/move`, { parentId: n.toyota.id })
          .expect(200);
      });

      it('refuses moves that break the levels or create a cycle', async () => {
        const wrongLevel = await alice
          .post(`/catalog/nodes/${n.le.id}/move`, { parentId: n.toyota.id })
          .expect(400);
        expect(wrongLevel.body.error.code).toBe('CATALOG_NODE_LEVEL_MISMATCH');
        const toTop = await alice
          .post(`/catalog/nodes/${n.camry.id}/move`, { parentId: null })
          .expect(400);
        expect(toTop.body.error.code).toBe('CATALOG_NODE_LEVEL_MISMATCH');
        const underSelf = await alice
          .post(`/catalog/nodes/${n.toyota.id}/move`, { parentId: n.camry.id })
          .expect(400);
        expect(['CATALOG_NODE_CYCLE', 'CATALOG_NODE_LEVEL_MISMATCH']).toContain(
          underSelf.body.error.code,
        );
        const self = await alice
          .post(`/catalog/nodes/${n.camry.id}/move`, { parentId: n.camry.id })
          .expect(400);
        expect(self.body.error.code).toBe('CATALOG_NODE_CYCLE');
      });

      it('reorders the children of a parent (the whole list is required)', async () => {
        const a = await addNode({ name: 'Alpha', parentId: n.toyota.id });
        const roots = (
          await alice.get('/catalog/nodes?parentId=' + n.toyota.id).expect(200)
        ).body.data as Node[];
        const ids = roots.map((r) => r.id).reverse();
        await alice
          .post('/catalog/nodes/reorder', {
            parentId: n.toyota.id,
            nodeIds: ids,
          })
          .expect(200);
        const after = (
          await alice.get('/catalog/nodes?parentId=' + n.toyota.id).expect(200)
        ).body.data as Node[];
        expect(after.map((r) => r.id)).toEqual(ids);
        const partial = await alice
          .post('/catalog/nodes/reorder', {
            parentId: n.toyota.id,
            nodeIds: [ids[0]],
          })
          .expect(400);
        expect(partial.body.error.code).toBe('CATALOG_NODE_ORDER_INCOMPLETE');
        await alice.delete(`/catalog/nodes/${a.id}`).expect(200);
      });

      it('deletes an item only without children, unless cascade is asked for', async () => {
        const blocked = await alice
          .delete(`/catalog/nodes/${n.camry.id}`)
          .expect(409);
        expect(blocked.body.error.code).toBe('CATALOG_NODE_HAS_CHILDREN');
        expect(blocked.body.error.details.descendants).toBe(2);
        const gone = await alice
          .delete(`/catalog/nodes/${n.camry.id}?cascade=true`)
          .expect(200);
        expect(gone.body.data.deleted).toBe(3);
        await alice.get(`/catalog/nodes/${n.le.id}`).expect(404);
        await alice.get(`/catalog/nodes/${n.camry.id}`).expect(404);
      });
    });

    describe('level order and level safety', () => {
      const n: Record<string, Node> = {};

      it('reorders levels that no item uses; refuses a reorder that would break existing relations', async () => {
        n.brand = await addNode({ name: 'Ford', status: 'active' });
        n.vehicle = await addNode({
          name: 'Focus',
          parentId: n.brand.id,
          status: 'active',
        });
        // Brand and Vehicle are used; Variant and Part group are not.
        const swapUsed = await alice
          .post('/catalog/levels/reorder', {
            levelIds: [
              levels.vehicle.id,
              levels.brand.id,
              levels.variant.id,
              levels.part.id,
            ],
          })
          .expect(409);
        expect(swapUsed.body.error.code).toBe('CATALOG_LEVEL_ORDER_BLOCKED');
        expect(swapUsed.body.error.details.problems.length).toBeGreaterThan(0);
        const unchanged = (await alice.get('/catalog/levels').expect(200)).body
          .data as Level[];
        expect(unchanged.map((l) => l.name)).toEqual([
          'Brand',
          'Vehicle',
          'Variant',
          'Part group',
        ]);
        // swapping the two unused ones is fine, and the tree is untouched
        const swapped = await alice
          .post('/catalog/levels/reorder', {
            levelIds: [
              levels.brand.id,
              levels.vehicle.id,
              levels.part.id,
              levels.variant.id,
            ],
          })
          .expect(200);
        expect((swapped.body.data as Level[]).map((l) => l.name)).toEqual([
          'Brand',
          'Vehicle',
          'Part group',
          'Variant',
        ]);
        const focus = (
          await alice.get(`/catalog/nodes/${n.vehicle.id}`).expect(200)
        ).body.data as Node;
        expect(focus).toMatchObject({ depth: 2, parentId: n.brand.id });
        // restore
        await alice
          .post('/catalog/levels/reorder', {
            levelIds: [
              levels.brand.id,
              levels.vehicle.id,
              levels.variant.id,
              levels.part.id,
            ],
          })
          .expect(200);
      });

      it('needs every level exactly once', async () => {
        const res = await alice
          .post('/catalog/levels/reorder', { levelIds: [levels.brand.id] })
          .expect(400);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_ORDER_INCOMPLETE');
      });

      it('refuses to insert a level in front of levels that have items, but allows it below them', async () => {
        const blocked = await alice
          .post('/catalog/levels', { name: 'Region', position: 1 })
          .expect(409);
        expect(blocked.body.error.code).toBe('CATALOG_LEVEL_ORDER_BLOCKED');
        const inserted = await addLevel('Trim', { position: 3 });
        expect(inserted.position).toBe(3);
        const list = (await alice.get('/catalog/levels').expect(200)).body
          .data as Level[];
        expect(list.map((l) => `${l.position}:${l.name}`)).toEqual([
          '1:Brand',
          '2:Vehicle',
          '3:Trim',
          '4:Variant',
          '5:Part group',
        ]);
        // deleting it closes the gap again
        await alice.delete(`/catalog/levels/${inserted.id}`).expect(200);
        const after = (await alice.get('/catalog/levels').expect(200)).body
          .data as Level[];
        expect(after.map((l) => `${l.position}:${l.name}`)).toEqual([
          '1:Brand',
          '2:Vehicle',
          '3:Variant',
          '4:Part group',
        ]);
      });

      it('does not delete a level that still has items', async () => {
        const res = await alice
          .delete(`/catalog/levels/${levels.brand.id}`)
          .expect(409);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_IN_USE');
      });
    });

    describe('placing products', () => {
      let brand: Node;
      let vehicle: Node;
      let variantA: Node;
      let variantB: Node;
      let partX: Node;
      let partY: Node;
      let p1: { id: string };
      let p2: { id: string };
      let p3: { id: string };

      beforeAll(async () => {
        // the variant level will carry products in some tests, the part level always does
        brand = await addNode({ name: 'Mazda', status: 'active' });
        vehicle = await addNode({
          name: 'Mazda 3',
          parentId: brand.id,
          status: 'active',
        });
        variantA = await addNode({
          name: 'Sport',
          parentId: vehicle.id,
          status: 'active',
        });
        variantB = await addNode({
          name: 'Touring',
          parentId: vehicle.id,
          status: 'active',
        });
        partX = await addNode({
          name: 'Brake pads',
          parentId: variantA.id,
          status: 'active',
        });
        partY = await addNode({
          name: 'Filters',
          parentId: variantB.id,
          status: 'active',
        });
        p1 = await product('Pad set', { sku: 'PAD-1', partNumber: 'BP-100' });
        p2 = await product('Oil filter', {
          sku: 'OIL-1',
          partNumber: 'OF-200',
        });
        p3 = await product('Air filter');
      });

      it('refuses to place products on an item whose level does not allow them', async () => {
        const res = await alice
          .post(`/catalog/nodes/${vehicle.id}/products`, {
            productIds: [p1.id],
          })
          .expect(400);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS');
      });

      it('places products without copying them, idempotently', async () => {
        const first = await alice
          .post(`/catalog/nodes/${partX.id}/products`, {
            productIds: [p1.id, p2.id],
          })
          .expect(201);
        expect(first.body.data).toEqual({ assigned: 2, alreadyAssigned: 0 });
        const again = await alice
          .post(`/catalog/nodes/${partX.id}/products`, {
            productIds: [p1.id, p3.id],
          })
          .expect(201);
        expect(again.body.data).toEqual({ assigned: 1, alreadyAssigned: 1 });
        // the same product on a second item (many-to-many)
        await alice
          .post(`/catalog/nodes/${partY.id}/products`, { productIds: [p2.id] })
          .expect(201);
        const count = await t.db.asOwner((pg) =>
          pg.query(
            "select count(*)::int as n from products where name = 'Oil filter'",
          ),
        );
        expect(count.rows[0]).toMatchObject({ n: 1 });
      });

      it('lists the products of an item with part number and SKU, searchable and in order, and with descendants', async () => {
        const list = await alice
          .get(`/catalog/nodes/${partX.id}/products`)
          .expect(200);
        expect(list.body.meta.total).toBe(3);
        expect(
          (list.body.data as { name: string }[]).map((x) => x.name),
        ).toEqual(['Pad set', 'Oil filter', 'Air filter']);
        expect(list.body.data[0]).toMatchObject({
          sku: 'PAD-1',
          partNumber: 'BP-100',
        });
        const search = await alice
          .get(`/catalog/nodes/${partX.id}/products?search=OF-200`)
          .expect(200);
        expect(
          (search.body.data as { name: string }[]).map((x) => x.name),
        ).toEqual(['Oil filter']);
        const none = await alice
          .get(`/catalog/nodes/${variantA.id}/products`)
          .expect(200);
        expect(none.body.data).toHaveLength(0);
        const viaChildren = await alice
          .get(`/catalog/nodes/${vehicle.id}/products?includeDescendants=true`)
          .expect(200);
        // Oil filter is on two items below, but listed once
        expect(viaChildren.body.meta.total).toBe(3);
        expect(
          (viaChildren.body.data as { name: string }[]).filter(
            (x) => x.name === 'Oil filter',
          ),
        ).toHaveLength(1);
      });

      it('counts products on the items and in the tree', async () => {
        const node = (await alice.get(`/catalog/nodes/${partX.id}`).expect(200))
          .body.data as Node;
        expect(node.productCount).toBe(3);
      });

      it('reorders the products of an item', async () => {
        await alice
          .post(`/catalog/nodes/${partX.id}/products/reorder`, {
            productIds: [p3.id, p2.id, p1.id],
          })
          .expect(200);
        const list = (
          await alice.get(`/catalog/nodes/${partX.id}/products`).expect(200)
        ).body.data as { name: string }[];
        expect(list.map((x) => x.name)).toEqual([
          'Air filter',
          'Oil filter',
          'Pad set',
        ]);
      });

      it('takes products off an item, one by one or in bulk, without deleting them', async () => {
        await alice
          .delete(`/catalog/nodes/${partX.id}/products/${p3.id}`)
          .expect(200);
        const bulk = await alice
          .post(`/catalog/nodes/${partX.id}/products/unassign`, {
            productIds: [p1.id, p3.id],
          })
          .expect(200);
        expect(bulk.body.data.removed).toBe(1);
        await alice.get(`/products/${p1.id}`).expect(200);
      });

      it('assigns many products to many items at once, all or nothing', async () => {
        const ok = await alice
          .post('/catalog/assignments/bulk', {
            action: 'assign',
            nodeIds: [partX.id, partY.id],
            productIds: [p1.id, p2.id, p3.id],
          })
          .expect(200);
        expect(ok.body.data.assigned + ok.body.data.alreadyAssigned).toBe(6);
        const before = await alice
          .get(`/catalog/nodes/${partY.id}/products`)
          .expect(200);
        // one bad item: nothing is added
        const bad = await alice
          .post('/catalog/assignments/bulk', {
            action: 'unassign',
            nodeIds: [partY.id, '00000000-0000-4000-8000-000000000000'],
            productIds: [p1.id],
          })
          .expect(404);
        expect(bad.body.error.code).toBe('CATALOG_NODE_NOT_FOUND');
        const after = await alice
          .get(`/catalog/nodes/${partY.id}/products`)
          .expect(200);
        expect(after.body.meta.total).toBe(before.body.meta.total);
        const holdless = await alice
          .post('/catalog/assignments/bulk', {
            action: 'assign',
            nodeIds: [partX.id, vehicle.id],
            productIds: [p1.id],
          })
          .expect(400);
        expect(holdless.body.error.code).toBe(
          'CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS',
        );
        const missing = await alice
          .post('/catalog/assignments/bulk', {
            action: 'assign',
            nodeIds: [partX.id],
            productIds: ['00000000-0000-4000-8000-000000000000'],
          })
          .expect(400);
        expect(missing.body.error.code).toBe('PRODUCT_NOT_FOUND');
        const huge = await alice
          .post('/catalog/assignments/bulk', {
            action: 'assign',
            nodeIds: Array.from(
              { length: 100 },
              (_, i) =>
                `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            ),
            productIds: Array.from(
              { length: 300 },
              (_, i) =>
                `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            ),
          })
          .expect(400);
        expect(huge.body.error.code).toBe('CATALOG_BULK_TOO_LARGE');
      });

      it("shows where a product sits, and sets its placements from the product's side", async () => {
        const where = (
          await alice.get(`/catalog/products/${p2.id}/nodes`).expect(200)
        ).body.data as { nodeId: string; names: string[]; path: string }[];
        expect(where.map((x) => x.names.join(' > ')).sort()).toEqual([
          'Mazda > Mazda 3 > Sport > Brake pads',
          'Mazda > Mazda 3 > Touring > Filters',
        ]);
        expect(where[0].path).toMatch(/^mazda\/mazda-3\//);
        const set = (
          await alice
            .put(`/catalog/products/${p2.id}/nodes`, { nodeIds: [partX.id] })
            .expect(200)
        ).body.data as { nodeId: string }[];
        expect(set.map((x) => x.nodeId)).toEqual([partX.id]);
        await alice
          .put(`/catalog/products/${p2.id}/nodes`, { nodeIds: [vehicle.id] })
          .expect(400);
        const cleared = (
          await alice
            .put(`/catalog/products/${p2.id}/nodes`, { nodeIds: [] })
            .expect(200)
        ).body.data as unknown[];
        expect(cleared).toHaveLength(0);
      });

      it('does not let the "can hold products" switch be turned off while products are placed', async () => {
        const res = await alice
          .patch(`/catalog/levels/${levels.part.id}`, {
            canHoldProducts: false,
          })
          .expect(409);
        expect(res.body.error.code).toBe('CATALOG_LEVEL_HAS_PRODUCTS');
      });

      it('removes the placement (not the product) when an item or a product is deleted', async () => {
        await alice.delete(`/catalog/nodes/${partY.id}`).expect(200);
        await alice.get(`/products/${p2.id}`).expect(200);
        await alice.delete(`/products/${p1.id}`).expect(200);
        const left = (
          await alice.get(`/catalog/nodes/${partX.id}/products`).expect(200)
        ).body.data as { id: string }[];
        expect(left.map((x) => x.id)).not.toContain(p1.id);
      });
    });

    describe('permissions and tenant isolation', () => {
      let other: Node;
      let aliceNode: Node;

      beforeAll(async () => {
        await bob
          .post('/catalog/levels', { name: 'Top', canHoldProducts: true })
          .expect(201);
        other = await addNode({ name: 'Bob item' }, bob);
        aliceNode = (
          (
            await alice
              .get('/catalog/nodes?parentId=root&search=Ford')
              .expect(200)
          ).body.data as Node[]
        )[0];
      });

      it("never shows another organization's hierarchy, levels or items", async () => {
        const list = (await bob.get('/catalog/nodes').expect(200)).body
          .data as Node[];
        expect(list.map((x) => x.name)).toEqual(['Bob item']);
        await bob.get(`/catalog/nodes/${aliceNode.id}`).expect(404);
        await bob
          .patch(`/catalog/nodes/${aliceNode.id}`, { name: 'Hacked' })
          .expect(404);
        await bob
          .delete(`/catalog/nodes/${aliceNode.id}?cascade=true`)
          .expect(404);
        await bob
          .patch(`/catalog/levels/${levels.brand.id}`, { name: 'Hacked' })
          .expect(404);
        await alice.get(`/catalog/nodes/${other.id}`).expect(404);
        const stillThere = (
          await alice.get(`/catalog/nodes/${aliceNode.id}`).expect(200)
        ).body.data as Node;
        expect(stillThere.name).toBe('Ford');
      });

      it("does not let one organization place another's products or use another's parent", async () => {
        const mine = await product('Alice only');
        const res = await bob
          .post(`/catalog/nodes/${other.id}/products`, {
            productIds: [mine.id],
          })
          .expect(400);
        expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
        const parent = await bob
          .post('/catalog/nodes', { name: 'Sneaky', parentId: aliceNode.id })
          .expect(400);
        expect(parent.body.error.code).toBe('CATALOG_PARENT_NOT_FOUND');
      });

      it('a read-only member can read but not change anything', async () => {
        await reader.get('/catalog/hierarchy').expect(200);
        await reader.get('/catalog/tree').expect(200);
        await reader.get(`/catalog/nodes/${aliceNode.id}`).expect(200);
        await reader.post('/catalog/nodes', { name: 'Nope' }).expect(403);
        await reader
          .patch(`/catalog/nodes/${aliceNode.id}`, { name: 'Nope' })
          .expect(403);
        await reader.delete(`/catalog/nodes/${aliceNode.id}`).expect(403);
        await reader.post('/catalog/levels', { name: 'Nope' }).expect(403);
        await reader
          .post(`/catalog/nodes/${aliceNode.id}/products`, {
            productIds: ['00000000-0000-4000-8000-000000000000'],
          })
          .expect(403);
      });

      it('a member without Products access cannot even read', async () => {
        await noAccess.get('/catalog/hierarchy').expect(403);
        await noAccess.get('/catalog/tree').expect(403);
      });

      it('a member with Products write can manage the catalog', async () => {
        const made = await writer
          .post('/catalog/nodes', { name: 'Writer item' })
          .expect(201);
        await writer.delete(`/catalog/nodes/${made.body.data.id}`).expect(200);
      });

      it('rejects invalid input', async () => {
        await alice.post('/catalog/nodes', { name: '' }).expect(400);
        await alice
          .post('/catalog/nodes', { name: 'Bad slug', slug: 'Not A Slug!' })
          .expect(400);
        await alice
          .post('/catalog/nodes', { name: 'Unknown field', surprise: true })
          .expect(400);
        await alice.get('/catalog/nodes/not-a-uuid').expect(400);
        await alice.get('/catalog/nodes?limit=1000').expect(400);
        await alice
          .post('/catalog/assignments/bulk', {
            action: 'assign',
            nodeIds: [],
            productIds: [],
          })
          .expect(400);
      });
    });
  },
);
