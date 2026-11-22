import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

/** Studio AC-CAT-2: deleting a product removes its collection memberships; deleted and draft products never reach a list; order is kept. */
describe.skipIf(!migrationsAvailable)(
  'collection membership after product changes (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
      t = await createTestApp(db);
      alice = await as(t, w.alice);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const product = async (name: string, status: 'active' | 'draft') =>
      (
        await alice
          .post('/products', { name, price: '10', status })
          .expect(201)
      ).body.data as { id: string; slug: string };

    const publicNames = async (collectionSlug: string) => {
      const res = await anonymous(t)
        .get(`/public/storefronts/alpha-shop/collections/${collectionSlug}`)
        .expect(200);
      return (res.body.data.products as { name: string }[]).map((p) => p.name);
    };

    it('removes the membership of a deleted product, keeps the rest in order, and never lists drafts', async () => {
      const first = await product('Cat2 First', 'active');
      const second = await product('Cat2 Second', 'active');
      const third = await product('Cat2 Third', 'active');
      const draft = await product('Cat2 Draft', 'draft');
      const made = (
        await alice
          .post('/collections', {
            name: 'Cat2 Collection',
            status: 'active',
            productIds: [first.id, second.id, draft.id, third.id],
          })
          .expect(201)
      ).body.data as { id: string; slug: string };

      // A draft product is in the collection but is never shown to shoppers; the others come in the saved order.
      expect(await publicNames(made.slug)).toEqual([
        'Cat2 First',
        'Cat2 Second',
        'Cat2 Third',
      ]);

      await alice.delete(`/products/${second.id}`).expect(200);

      const after = (await alice.get(`/collections/${made.id}`).expect(200))
        .body.data as { productIds?: string[]; products?: { id: string }[] };
      const ids = after.productIds ?? after.products?.map((p) => p.id) ?? [];
      expect(ids).not.toContain(second.id);
      expect(ids).toEqual([first.id, draft.id, third.id]);
      expect(await publicNames(made.slug)).toEqual([
        'Cat2 First',
        'Cat2 Third',
      ]);

      // The row itself is gone, not just hidden.
      const rows = await t.db.asOwner((pg) =>
        pg.query('select 1 from collection_products where product_id = $1', [
          second.id,
        ]),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('lists a draft product once it is published, and not after it goes back to draft', async () => {
      const p = await product('Cat2 Toggle', 'draft');
      const made = (
        await alice
          .post('/collections', {
            name: 'Cat2 Toggle Collection',
            status: 'active',
            productIds: [p.id],
          })
          .expect(201)
      ).body.data as { id: string; slug: string };
      expect(await publicNames(made.slug)).toEqual([]);
      await alice.patch(`/products/${p.id}`, { status: 'active' }).expect(200);
      expect(await publicNames(made.slug)).toEqual(['Cat2 Toggle']);
      await alice.patch(`/products/${p.id}`, { status: 'draft' }).expect(200);
      expect(await publicNames(made.slug)).toEqual([]);
    });
  },
);
