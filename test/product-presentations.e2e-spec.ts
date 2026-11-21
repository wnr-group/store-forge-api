import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Detail = {
  productId: string;
  revision: number;
  publicationState: string;
  document: Record<string, unknown>;
  publishedDocument: Record<string, unknown> | null;
  published?: boolean;
};

const doc = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  ...extra,
});
const STACKED = doc({
  gallery: { layout: 'stacked', mediaPosition: 'right' },
  focalPoint: { x: 30, y: 70 },
  hiddenBlocks: ['product-sku'],
});

describe.skipIf(!migrationsAvailable)('product presentations (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client;
  let bob: Client;
  let counter = 0;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const makeProduct = async (c: Client, status = 'active') => {
    const res = await c
      .post('/products', {
        name: `Item ${++counter} ${randomUUID().slice(0, 6)}`,
        price: '100',
        status,
      })
      .expect(201);
    return res.body.data as { id: string; slug: string };
  };
  const url = (id: string, tail = '') =>
    `/store/product-presentations/${id}${tail}`;
  const detail = async (c: Client, id: string) =>
    (await c.get(url(id)).expect(200)).body.data as Detail;
  const save = (c: Client, id: string, document: object, rev: number) =>
    c.put(url(id, '/draft'), { document, expectedRevision: rev });
  const publicProduct = async (shop: string, slug: string) =>
    (await anonymous(t).get(`/public/storefronts/${shop}/products/${slug}`))
      .body.data;
  const ownerSql = <T = unknown>(text: string, params: unknown[] = []) =>
    t.db.asOwner(async (pg) => (await pg.query<T>(text, params)).rows);

  describe('reading', () => {
    it('returns the default for a product that was never customized', async () => {
      const p = await makeProduct(alice);
      const d = await detail(alice, p.id);
      expect(d).toMatchObject({
        productId: p.id,
        revision: 0,
        publicationState: 'default',
        document: { schemaVersion: 1 },
        publishedDocument: null,
      });
    });

    it('404s for unknown products and for another organization’s product', async () => {
      const mine = await makeProduct(alice);
      await alice.get(url(randomUUID())).expect(404);
      await bob.get(url(mine.id)).expect(404);
      await bob
        .put(url(mine.id, '/draft'), { document: doc(), expectedRevision: 0 })
        .expect(404);
      await bob.post(url(mine.id, '/publish'), {}).expect(404);
      await bob.delete(url(mine.id)).expect(404);
      await alice.get('/store/product-presentations/not-a-uuid').expect(400);
    });

    it('requires authentication and organization access', async () => {
      const p = await makeProduct(alice);
      await anonymous(t).get(url(p.id)).expect(401);
      const forged = await as(t, w.alice, w.tenantB);
      await forged.get(url(p.id)).expect(403);
    });
  });

  describe('drafts and revisions', () => {
    it('creates with revision 0, bumps on change, keeps it when nothing changed', async () => {
      const p = await makeProduct(alice);
      const created = (await save(alice, p.id, STACKED, 0).expect(200)).body
        .data as Detail;
      expect(created).toMatchObject({
        revision: 1,
        publicationState: 'draft',
        document: STACKED,
        publishedDocument: null,
      });

      const same = (await save(alice, p.id, STACKED, 1).expect(200)).body
        .data as Detail;
      expect(same.revision).toBe(1);

      const changed = (
        await save(
          alice,
          p.id,
          doc({ gallery: { layout: 'thumbnails' } }),
          1,
        ).expect(200)
      ).body.data as Detail;
      expect(changed.revision).toBe(2);
    });

    it('answers 409 for a stale revision and for creating twice, and writes nothing', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      const again = await save(alice, p.id, doc(), 0).expect(409);
      expect(again.body.error.code).toBe('PRESENTATION_REVISION_CONFLICT');
      await save(alice, p.id, doc(), 7).expect(409);
      expect((await detail(alice, p.id)).document).toEqual(STACKED);
    });

    it('lets only one of two parallel creations win', async () => {
      const p = await makeProduct(alice);
      const results = await Promise.all([
        save(alice, p.id, doc({ gallery: { layout: 'stacked' } }), 0),
        save(alice, p.id, doc({ gallery: { layout: 'thumbnails' } }), 0),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect((await detail(alice, p.id)).revision).toBe(1);
      const rows = await ownerSql(
        'select 1 from product_presentations where product_id = $1',
        [p.id],
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects invalid settings with field errors and stores nothing', async () => {
      const p = await makeProduct(alice);
      const res = await save(
        alice,
        p.id,
        doc({
          card: { radius: 4 },
          price: 1,
          gallery: { layout: 'masonry' },
          focalPoint: { x: 101, y: 0 },
          hiddenBlocks: ['product-title'],
        }),
        0,
      ).expect(400);
      expect(res.body.error.code).toBe('PRESENTATION_DOCUMENT_INVALID');
      expect(Object.keys(res.body.error.details)).toEqual(
        expect.arrayContaining([
          `productPresentation.${p.id}.card`,
          `productPresentation.${p.id}.price`,
          `productPresentation.${p.id}.gallery.layout`,
          `productPresentation.${p.id}.focalPoint.x`,
          `productPresentation.${p.id}.hiddenBlocks[0]`,
        ]),
      );
      expect((await detail(alice, p.id)).revision).toBe(0);
      // A missing or negative revision and a non-object document are rejected before anything runs.
      await alice.put(url(p.id, '/draft'), { document: doc() }).expect(400);
      await save(alice, p.id, doc(), -1).expect(400);
      await alice
        .put(url(p.id, '/draft'), { document: 'x', expectedRevision: 0 })
        .expect(400);
    });

    it('lists customized products with ids and states only', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      const res = await alice
        .get('/store/product-presentations?limit=100')
        .expect(200);
      const mine = res.body.data.find(
        (x: { productId: string }) => x.productId === p.id,
      );
      expect(mine).toMatchObject({ revision: 1, publicationState: 'draft' });
      expect(Object.keys(mine).sort()).toEqual(
        [
          'productId',
          'publicationState',
          'publishedAt',
          'revision',
          'updatedAt',
        ].sort(),
      );
      expect(res.body.meta.total).toBeGreaterThan(0);
      // Another organization never sees it.
      const bobs = await bob.get('/store/product-presentations').expect(200);
      expect(bobs.body.data).toEqual([]);
    });
  });

  describe('publishing and public exposure', () => {
    it('shows only published settings to shoppers, keeps the draft private, and resets at once', async () => {
      const p = await makeProduct(alice);
      const before = await publicProduct('alpha-shop', p.slug);
      expect(before.presentation).toBeNull();

      await save(alice, p.id, STACKED, 0).expect(200);
      expect(
        (await publicProduct('alpha-shop', p.slug)).presentation,
      ).toBeNull();

      await alice.post(url(randomUUID(), '/publish'), {}).expect(404);
      const pub = (
        await alice
          .post(url(p.id, '/publish'), { expectedRevision: 1 })
          .expect(200)
      ).body.data as Detail;
      expect(pub).toMatchObject({
        published: true,
        publicationState: 'published',
        publishedDocument: STACKED,
      });
      const live = await publicProduct('alpha-shop', p.slug);
      expect(live.presentation).toEqual(STACKED);

      // Publishing again changes nothing.
      const again = (await alice.post(url(p.id, '/publish'), {}).expect(200))
        .body.data as Detail;
      expect(again.published).toBe(false);

      // An edit stays a draft; shoppers keep the previous version.
      const edited = doc({ gallery: { layout: 'thumbnails' } });
      await save(alice, p.id, edited, 1).expect(200);
      expect((await detail(alice, p.id)).publicationState).toBe(
        'published_with_changes',
      );
      expect((await publicProduct('alpha-shop', p.slug)).presentation).toEqual(
        STACKED,
      );
      expect(
        JSON.stringify(await publicProduct('alpha-shop', p.slug)),
      ).not.toContain('thumbnails');

      // A stale revision cannot publish.
      const stale = await alice
        .post(url(p.id, '/publish'), { expectedRevision: 1 })
        .expect(409);
      expect(stale.body.error.code).toBe('PRESENTATION_REVISION_CONFLICT');
      await alice
        .post(url(p.id, '/publish'), { expectedRevision: 2 })
        .expect(200);
      expect((await publicProduct('alpha-shop', p.slug)).presentation).toEqual(
        edited,
      );

      // Reset is immediate and idempotent.
      const reset = (await alice.delete(url(p.id)).expect(200)).body
        .data as Detail;
      expect(reset).toMatchObject({ revision: 0, publicationState: 'default' });
      expect(
        (await publicProduct('alpha-shop', p.slug)).presentation,
      ).toBeNull();
      await alice.delete(url(p.id)).expect(200);
      expect((await detail(alice, p.id)).publicationState).toBe('default');
    });

    it('does not publish an empty draft of a never-published product', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, doc(), 0).expect(200);
      const res = (await alice.post(url(p.id, '/publish'), {}).expect(200)).body
        .data as Detail;
      expect(res.published).toBe(false);
      expect(res.publishedDocument).toBeNull();
    });

    it('never leaks another organization’s settings, even for the same slug', async () => {
      const mine = await makeProduct(alice);
      const theirs = await bob
        .post('/products', {
          name: 'Twin',
          slug: mine.slug,
          price: '1',
          status: 'active',
        })
        .expect(201);
      await save(alice, mine.id, STACKED, 0).expect(200);
      await alice.post(url(mine.id, '/publish'), {}).expect(200);
      expect(
        (await publicProduct('alpha-shop', mine.slug)).presentation,
      ).toEqual(STACKED);
      expect(
        (await publicProduct('beta-shop', theirs.body.data.slug)).presentation,
      ).toBeNull();
    });

    it('returns only the known published keys and no internal fields', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      await alice.post(url(p.id, '/publish'), {}).expect(200);
      // Written directly (bypassing the API) with extra keys: the public function must project, not pass through.
      await ownerSql(
        `update product_presentations set published = published || '{"secret":"x","card":{"a":1}}'::jsonb where product_id = $1`,
        [p.id],
      );
      const live = await publicProduct('alpha-shop', p.slug);
      expect(Object.keys(live.presentation).sort()).toEqual([
        'focalPoint',
        'gallery',
        'hiddenBlocks',
        'schemaVersion',
      ]);
      const text = JSON.stringify(live);
      for (const k of [
        'revision',
        'tenant_id',
        'store_id',
        'published_by',
        'draft',
        'secret',
      ])
        expect(text).not.toContain(`"${k}"`);
    });

    it('keeps the existing public behaviour: available flags, no presentation on cards, inactive products hidden', async () => {
      const p = await makeProduct(alice);
      const live = await publicProduct('alpha-shop', p.slug);
      expect(live.product).toHaveProperty('available');
      expect(live.product.name).toMatch(/^Item/);
      expect(Object.keys(live).sort()).toEqual([
        'images',
        'options',
        'presentation',
        'product',
        'related',
        'store',
        'variants',
      ]);
      await save(alice, p.id, STACKED, 0).expect(200);
      await alice.post(url(p.id, '/publish'), {}).expect(200);
      const customised = await publicProduct('alpha-shop', p.slug);
      expect(customised.product).toEqual(live.product);
      expect(customised.images).toEqual(live.images);
      expect(customised.related).toEqual(live.related);

      // Cards are unchanged: the storefront list carries `available` and no presentation.
      const store = (await anonymous(t).get('/public/storefronts/alpha-shop'))
        .body.data;
      expect(store.products.length).toBeGreaterThan(0);
      for (const card of store.products) {
        expect(card).toHaveProperty('available');
        expect(card).not.toHaveProperty('presentation');
      }
      for (const card of customised.related)
        expect(card).not.toHaveProperty('presentation');

      // A product that is not active stays hidden even when its settings are published.
      const hidden = await makeProduct(alice, 'draft');
      await save(alice, hidden.id, STACKED, 0).expect(200);
      await alice.post(url(hidden.id, '/publish'), {}).expect(200);
      await anonymous(t)
        .get(`/public/storefronts/alpha-shop/products/${hidden.slug}`)
        .expect(404);
    });

    it('keeps `available` correct for stock-tracked products', async () => {
      const sold = await alice
        .post('/products', {
          name: 'Sold Out Thing',
          price: '5',
          status: 'active',
          trackInventory: true,
          quantity: 0,
        })
        .expect(201);
      const before = await publicProduct('alpha-shop', sold.body.data.slug);
      expect(before.product.available).toBe(false);
      await save(alice, sold.body.data.id, STACKED, 0).expect(200);
      await alice.post(url(sold.body.data.id, '/publish'), {}).expect(200);
      const after = await publicProduct('alpha-shop', sold.body.data.slug);
      expect(after.product.available).toBe(false);
      expect(after.presentation).toEqual(STACKED);
    });
  });

  describe('permissions and isolation', () => {
    it('lets read-only members read but not change anything', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      const reader = await as(t, w.members.reader, w.tenantA);
      await reader.get(url(p.id)).expect(200);
      await reader.get('/store/product-presentations').expect(200);
      await save(reader, p.id, doc(), 1).expect(403);
      await reader.post(url(p.id, '/publish'), {}).expect(403);
      await reader.delete(url(p.id)).expect(403);
      expect((await detail(alice, p.id)).revision).toBe(1);
      // A member with write access to settings may edit.
      const writer = await as(t, w.members.writer, w.tenantA);
      await save(writer, p.id, doc(), 1).expect(200);
      const nobody = await as(t, w.members.nothing, w.tenantA);
      await save(nobody, p.id, doc(), 2).expect(403);
    });

    it('is enforced by the database too: no cross-tenant reads, writes or inserts', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      const rows = await t.db.service.withUser(w.bob, async (tx) =>
        tx.execute(sql`select product_id from public.product_presentations`),
      );
      expect((rows as unknown as { rows: unknown[] }).rows).toHaveLength(0);

      // Bob cannot insert a row for Alice's tenant/product.
      await expect(
        t.db.service.withUser(w.bob, (tx) =>
          tx.execute(
            sql`insert into public.product_presentations (tenant_id, store_id, product_id, draft)
                values (${w.tenantA}, ${w.storeA}, ${randomUUID()}, '{"schemaVersion":1}'::jsonb)`,
          ),
        ),
      ).rejects.toThrow();
      // Bob cannot change or delete Alice's row (RLS hides it: nothing is affected).
      await t.db.service.withUser(w.bob, async (tx) => {
        await tx.execute(
          sql`update public.product_presentations set draft = '{"schemaVersion":1}'::jsonb where product_id = ${p.id}`,
        );
        await tx.execute(
          sql`delete from public.product_presentations where product_id = ${p.id}`,
        );
      });
      expect((await detail(alice, p.id)).document).toEqual(STACKED);
    });
  });

  describe('database rules', () => {
    it('sets revision, publish stamp and timestamps itself; clients cannot', async () => {
      const p = await makeProduct(alice);
      await save(alice, p.id, STACKED, 0).expect(200);
      // The app role may not write revision / published_at / published_by.
      for (const col of [
        'revision = 9',
        'published_at = now()',
        `published_by = '${w.alice}'`,
      ])
        await expect(
          t.db.service.withUser(w.alice, (tx) =>
            tx.execute(
              sql.raw(
                `update public.product_presentations set ${col} where product_id = '${p.id}'`,
              ),
            ),
          ),
        ).rejects.toThrow();
      await alice.post(url(p.id, '/publish'), {}).expect(200);
      const [row] = await ownerSql<{
        published_by: string;
        published_at: string;
        revision: number;
      }>(
        'select published_by, published_at, revision from product_presentations where product_id = $1',
        [p.id],
      );
      expect(row!.published_by).toBe(w.alice);
      expect(row!.published_at).not.toBeNull();
      expect(row!.revision).toBe(1);
    });

    it('starts every row unpublished at revision 1 even if the insert says otherwise', async () => {
      const p = await makeProduct(alice);
      await ownerSql(
        `insert into product_presentations (tenant_id, store_id, product_id, draft, published, revision, published_at)
         values ($1, $2, $3, '{"schemaVersion":1}', '{"schemaVersion":1}', 9, now())`,
        [w.tenantA, w.storeA, p.id],
      );
      const [row] = await ownerSql<{
        published: unknown;
        revision: number;
        published_at: unknown;
      }>(
        'select published, revision, published_at from product_presentations where product_id = $1',
        [p.id],
      );
      expect(row).toEqual({ published: null, revision: 1, published_at: null });
    });

    it('enforces shape, size, tenant of the product and cascade on delete', async () => {
      const p = await makeProduct(alice);
      const insert = (
        draft: string,
        tenant = w.tenantA,
        store = w.storeA,
        product = p.id,
      ) =>
        ownerSql(
          'insert into product_presentations (tenant_id, store_id, product_id, draft) values ($1,$2,$3,$4::jsonb)',
          [tenant, store, product, draft],
        );
      await expect(insert('{"nope":1}')).rejects.toThrow();
      await expect(insert('[]')).rejects.toThrow();
      await expect(
        insert(JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(9000) })),
      ).rejects.toThrow();
      // The product must belong to the tenant, and the store to the tenant.
      await expect(
        insert('{"schemaVersion":1}', w.tenantB, w.storeB, p.id),
      ).rejects.toThrow();
      await expect(
        insert('{"schemaVersion":1}', w.tenantA, w.storeB, p.id),
      ).rejects.toThrow();
      await insert('{"schemaVersion":1}');
      await expect(insert('{"schemaVersion":1}')).rejects.toThrow(); // one row per product
      await expect(
        ownerSql(
          `update product_presentations set published = '{"schemaVersion":1}' , published_at = null where product_id = $1`,
          [p.id],
        ),
      ).resolves.toBeDefined(); // the trigger stamps published_at itself, so the pair check holds

      await alice.delete(`/products/${p.id}`).expect(200);
      const left = await ownerSql(
        'select 1 from product_presentations where product_id = $1',
        [p.id],
      );
      expect(left).toHaveLength(0);
    });
  });

  describe('publish-all', () => {
    it('publishes product settings together with the theme, and all-or-nothing on a problem', async () => {
      await alice
        .post('/store/theme', { themeSlug: 'plain' })
        .expect(201)
        .catch(async () => {
          await alice.post('/store/theme', { themeSlug: 'plain' }).expect(200);
        });
      const good = await makeProduct(alice);
      const bad = await makeProduct(alice);
      const untouched = await makeProduct(alice);
      await save(alice, good.id, STACKED, 0).expect(200);
      await save(
        alice,
        bad.id,
        doc({ gallery: { layout: 'stacked' } }),
        0,
      ).expect(200);
      // An invalid draft that only a direct database write can produce.
      await ownerSql(
        `update product_presentations set draft = '{"schemaVersion":1,"price":5}'::jsonb where product_id = $1`,
        [bad.id],
      );

      const failed = await alice.post('/store/theme/publish', {}).expect(400);
      expect(failed.body.error.code).toBe('TEMPLATE_DOCUMENT_INVALID');
      expect(Object.keys(failed.body.error.details)).toContain(
        `productPresentation.${bad.id}.price`,
      );
      // Nothing went live: not the good product, and not a single template.
      expect((await detail(alice, good.id)).publicationState).toBe('draft');
      expect(
        (await publicProduct('alpha-shop', good.slug)).presentation,
      ).toBeNull();
      const templates = (await alice.get('/store/templates').expect(200)).body
        .data as {
        publicationState: string;
      }[];
      expect(templates.every((x) => x.publicationState === 'draft')).toBe(true);

      await save(
        alice,
        bad.id,
        doc({ hiddenBlocks: ['social-share'] }),
        2,
      ).expect(200);
      const ok = await alice
        .post('/store/theme/publish', { label: 'All' })
        .expect(200);
      // Drafts left by earlier tests in this store go live too, so only a lower bound is stable.
      expect(
        ok.body.data.productPresentations.published,
      ).toBeGreaterThanOrEqual(2);
      expect((await detail(alice, good.id)).publicationState).toBe('published');
      expect((await detail(alice, bad.id)).publicationState).toBe('published');
      expect((await detail(alice, untouched.id)).publicationState).toBe(
        'default',
      );
      expect(
        (await publicProduct('alpha-shop', good.slug)).presentation,
      ).toEqual(STACKED);

      // Running it again has nothing new to publish; other organizations are never touched.
      const again = await alice.post('/store/theme/publish', {}).expect(200);
      expect(again.body.data.productPresentations).toEqual({ published: 0 });
      expect(again.body.data.published).toEqual([]);
    });

    it('works for a store with no product settings at all', async () => {
      await bob
        .post('/store/theme', { themeSlug: 'plain' })
        .expect(201)
        .catch(async () => {
          await bob.post('/store/theme', { themeSlug: 'plain' }).expect(200);
        });
      const res = await bob.post('/store/theme/publish', {}).expect(200);
      expect(res.body.data.productPresentations).toEqual({ published: 0 });
      expect(res.body.data.published.length).toBeGreaterThan(0);
    });
  });
});
