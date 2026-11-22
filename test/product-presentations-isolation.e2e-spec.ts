import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
const STACKED = {
  schemaVersion: 1,
  gallery: { layout: 'stacked' },
  hiddenBlocks: ['product-sku'],
};
const THUMBS = { schemaVersion: 1, gallery: { layout: 'thumbnails' } };

describe.skipIf(!migrationsAvailable)(
  'product presentation isolation (e2e)',
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
      await alice.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const product = async () =>
      (
        await alice
          .post('/products', {
            name: `P ${randomUUID().slice(0, 6)}`,
            price: '10',
            status: 'active',
          })
          .expect(201)
      ).body.data as { id: string; slug: string };
    const url = (id: string, tail = '') =>
      `/store/product-presentations/${id}${tail}`;
    const pub = async (slug: string) =>
      (await anonymous(t).get(`/public/storefronts/alpha-shop/products/${slug}`))
        .body.data;
    const productTemplate = async () => {
      const list = (await alice.get('/store/templates').expect(200)).body
        .data as { id: string; kind: string; isDefault: boolean }[];
      const row = list.find((x) => x.kind === 'product' && x.isDefault)!;
      return (await alice.get(`/store/templates/${row.id}`).expect(200)).body
        .data as { revision: number; document: unknown; publicationState: string };
    };

    it('customising one product leaves the shared product template untouched', async () => {
      const before = await productTemplate();
      const p = await product();
      await alice
        .put(url(p.id, '/draft'), { document: STACKED, expectedRevision: 0 })
        .expect(200);
      await alice
        .post(url(p.id, '/publish'), { expectedRevision: 1 })
        .expect(200);
      expect(await productTemplate()).toEqual(before);
    });

    it('publishes to the right product only, and reset of one product leaves the other as it was', async () => {
      const a = await product();
      const b = await product();
      const c = await product();
      await alice
        .put(url(a.id, '/draft'), { document: STACKED, expectedRevision: 0 })
        .expect(200);
      await alice
        .put(url(b.id, '/draft'), { document: THUMBS, expectedRevision: 0 })
        .expect(200);
      await alice.post(url(a.id, '/publish'), { expectedRevision: 1 }).expect(200);
      await alice.post(url(b.id, '/publish'), { expectedRevision: 1 }).expect(200);
      expect((await pub(a.slug)).presentation).toEqual(STACKED);
      expect((await pub(b.slug)).presentation).toEqual(THUMBS);
      expect((await pub(c.slug)).presentation).toBeNull();

      await alice.delete(url(a.id)).expect(200);
      expect((await pub(a.slug)).presentation).toBeNull();
      expect((await pub(b.slug)).presentation).toEqual(THUMBS);
      expect((await alice.get(url(b.id)).expect(200)).body.data.revision).toBe(1);
    });
  },
);
