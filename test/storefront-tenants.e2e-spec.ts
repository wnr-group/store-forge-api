import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type PublicProduct = {
  name: string;
  slug: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  available: boolean;
};

/**
 * Two stores, two catalogues, two themes: what each storefront shows must be that store's own active products, whatever
 * the theme, and changing or switching a theme must never touch the products.
 */
describe.skipIf(!migrationsAvailable)(
  'storefront shows each tenant its own products (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client; // owner of A, store "alpha-shop", theme atelier
    let bob: Client; // owner of B, store "beta-shop", theme voltage

    const storefront = async (slug: string) =>
      (await anonymous(t).get(`/public/storefronts/${slug}`).expect(200)).body
        .data as { products: PublicProduct[] };
    const names = async (slug: string) =>
      (await storefront(slug)).products.map((p) => p.name).sort();
    const layout = async (slug: string) =>
      (
        await anonymous(t)
          .get(`/public/storefronts/${slug}/layout?kind=index`)
          .expect(200)
      ).body.data;
    const heroVariant = async (slug: string) => {
      const doc = (await layout(slug)).template.document;
      const hero = Object.values(doc.sections as Record<string, any>).find(
        (s) => s.type === 'hero',
      );
      return hero?.settings.variant as string;
    };
    const snapshot = async (c: Client) =>
      (await c.get('/products?limit=100').expect(200)).body.data.map(
        (p: any) => ({
          id: p.id,
          name: p.name,
          priceMinor: p.priceMinor,
          status: p.status,
          quantity: p.quantity,
          updatedAt: p.updatedAt,
        }),
      );

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);

      // Tenant A: fashion catalogue, one draft, one sold out, one on sale.
      const scarf = await alice
        .post('/products', {
          name: 'Wool Scarf',
          price: '499',
          status: 'active',
          quantity: 10,
        })
        .expect(201);
      await alice
        .post('/products', {
          name: 'Linen Shirt',
          price: '999',
          compareAtPrice: '1299',
          status: 'active',
          quantity: 5,
        })
        .expect(201);
      await alice
        .post('/products', {
          name: 'Sold Out Tee',
          price: '299',
          status: 'active',
          quantity: 0,
        })
        .expect(201);
      await alice
        .post('/products', {
          name: 'Unreleased Coat',
          price: '4999',
          status: 'draft',
          quantity: 3,
        })
        .expect(201);
      await alice
        .post('/collections', {
          name: 'Winter',
          status: 'active',
          productIds: [scarf.body.data.id],
        })
        .expect(201);

      // Tenant B: electronics catalogue.
      await bob
        .post('/products', {
          name: 'Gaming Mouse',
          price: '1999',
          status: 'active',
          quantity: 20,
        })
        .expect(201);
      await bob
        .post('/products', {
          name: 'USB Cable',
          price: '199',
          status: 'active',
          quantity: 100,
        })
        .expect(201);

      // Different themes, both published.
      await alice.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
      await alice.post('/store/theme/publish', {}).expect(200);
      await bob.post('/store/theme', { themeSlug: 'voltage' }).expect(200);
      await bob.post('/store/theme/publish', {}).expect(200);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    it("tenant A sees only A's active products, tenant B only B's", async () => {
      expect(await names('alpha-shop')).toEqual([
        'Linen Shirt',
        'Sold Out Tee',
        'Wool Scarf',
      ]);
      expect(await names('beta-shop')).toEqual(['Gaming Mouse', 'USB Cable']);
    });

    it('never exposes an unpublished (draft) product, on any public route', async () => {
      expect(await names('alpha-shop')).not.toContain('Unreleased Coat');
      await anonymous(t)
        .get('/public/storefronts/alpha-shop/products/unreleased-coat')
        .expect(404);
    });

    it('keeps each theme its own layout while sharing one data source', async () => {
      expect(await heroVariant('alpha-shop')).toBe('banner'); // atelier
      expect(await heroVariant('beta-shop')).toBe('split'); // voltage
      // The theme document carries design only: no product data at all.
      const docs = JSON.stringify([
        await layout('alpha-shop'),
        await layout('beta-shop'),
      ]);
      for (const name of [
        'Wool Scarf',
        'Linen Shirt',
        'Gaming Mouse',
        'USB Cable',
      ])
        expect(docs).not.toContain(name);
    });

    it('shows sale prices and availability without exposing stock counts', async () => {
      const { products } = await storefront('alpha-shop');
      const shirt = products.find((p) => p.name === 'Linen Shirt')!;
      expect(shirt).toMatchObject({
        priceMinor: 99900,
        compareAtPriceMinor: 129900,
        available: true,
      });
      expect(products.find((p) => p.name === 'Sold Out Tee')!.available).toBe(
        false,
      );
      expect(products.find((p) => p.name === 'Wool Scarf')!.available).toBe(
        true,
      );
      expect(JSON.stringify(products)).not.toMatch(/quantity|stock/i);
    });

    it('serves collection products from the right store only', async () => {
      const winter = await anonymous(t)
        .get('/public/storefronts/alpha-shop/collections/winter')
        .expect(200);
      expect(
        winter.body.data.products.map((p: PublicProduct) => p.name),
      ).toEqual(['Wool Scarf']);
      expect(winter.body.data.products[0].available).toBe(true);
      // Same address on the other store is not found, never the first store's collection.
      await anonymous(t)
        .get('/public/storefronts/beta-shop/collections/winter')
        .expect(404);
      await anonymous(t)
        .get('/public/storefronts/beta-shop/products/wool-scarf')
        .expect(404);
    });

    it('lets a merchant read only their own catalogue in the dashboard API', async () => {
      const mine = (await alice.get('/products?limit=100').expect(200)).body
        .data;
      expect(mine.map((p: any) => p.name)).not.toContain('Gaming Mouse');
      const theirs = (await bob.get('/products?limit=100').expect(200)).body
        .data;
      expect(theirs.map((p: any) => p.name)).not.toContain('Wool Scarf');
    });

    it('shows a product update on the storefront, for that store only', async () => {
      const list = (await alice.get('/products?limit=100').expect(200)).body
        .data as any[];
      const mouseBefore = (await storefront('beta-shop')).products.find(
        (p) => p.name === 'Gaming Mouse',
      )!;
      const scarf = list.find((p) => p.name === 'Wool Scarf');
      await alice
        .patch(`/products/${scarf.id}`, { price: '549.50' })
        .expect(200);
      const after = (await storefront('alpha-shop')).products.find(
        (p) => p.name === 'Wool Scarf',
      )!;
      expect(after.priceMinor).toBe(54950);
      expect(
        (await storefront('beta-shop')).products.find(
          (p) => p.name === 'Gaming Mouse',
        ),
      ).toEqual(mouseBefore);
    });

    it('hides a product when it is switched to draft, and shows it again when activated', async () => {
      const list = (await alice.get('/products?limit=100').expect(200)).body
        .data as any[];
      const tee = list.find((p) => p.name === 'Sold Out Tee');
      await alice.patch(`/products/${tee.id}`, { status: 'draft' }).expect(200);
      expect(await names('alpha-shop')).not.toContain('Sold Out Tee');
      await alice
        .patch(`/products/${tee.id}`, { status: 'active' })
        .expect(200);
      expect(await names('alpha-shop')).toContain('Sold Out Tee');
    });

    it('does not touch any product when the theme is switched, edited or rolled back', async () => {
      const before = await snapshot(alice);
      await alice.post('/store/theme', { themeSlug: 'voltage' }).expect(200);
      await alice.post('/store/theme/publish', {}).expect(200);
      expect(await heroVariant('alpha-shop')).toBe('split'); // layout followed the theme…
      expect(await snapshot(alice)).toEqual(before); // …the products did not move
      expect(await names('alpha-shop')).toEqual([
        'Linen Shirt',
        'Sold Out Tee',
        'Wool Scarf',
      ]);
      // And the other tenant is unaffected by A's theme change.
      expect(await heroVariant('beta-shop')).toBe('split');
      expect(await names('beta-shop')).toEqual(['Gaming Mouse', 'USB Cable']);
    });

    it('shows an empty catalogue as empty, never with invented products', async () => {
      const mine = (await bob.get('/products?limit=100').expect(200)).body
        .data as any[];
      await bob
        .post('/products/bulk-delete', { ids: mine.map((p) => p.id) })
        .expect((r) => {
          if (![200, 204].includes(r.status))
            throw new Error(`bulk delete returned ${r.status}`);
        });
      const empty = await storefront('beta-shop');
      expect(empty.products).toEqual([]);
      // The design is still published and served, so the storefront can render its empty state.
      expect((await layout('beta-shop')).template).not.toBeNull();
      // The other store keeps its products.
      expect(await names('alpha-shop')).toHaveLength(3);
    });

    it('serves each store its own SEO title and description, and hides them with an inactive store', async () => {
      type Seo = { metaTitle: string | null; metaDescription: string | null };
      const seo = async (slug: string) =>
        (await storefront(slug)) as unknown as Seo;

      // Nothing saved yet: both fields are present and null.
      expect(await seo('alpha-shop')).toMatchObject({
        metaTitle: null,
        metaDescription: null,
      });

      await alice
        .patch('/store', {
          metaTitle: 'Alpha: coats and scarves',
          metaDescription: 'Warm things for cold days.',
        })
        .expect(200);
      await bob.patch('/store', { metaTitle: 'Beta: gaming gear' }).expect(200);

      expect(await seo('alpha-shop')).toMatchObject({
        metaTitle: 'Alpha: coats and scarves',
        metaDescription: 'Warm things for cold days.',
      });
      // B only set a title: its description stays null and A's never leaks over.
      expect(await seo('beta-shop')).toMatchObject({
        metaTitle: 'Beta: gaming gear',
        metaDescription: null,
      });

      // Clearing a value shows on the storefront too.
      await alice.patch('/store', { metaTitle: null }).expect(200);
      expect(await seo('alpha-shop')).toMatchObject({
        metaTitle: null,
        metaDescription: 'Warm things for cold days.',
      });

      // An inactive store still answers 404 (the visibility rule is unchanged), and comes back with its values.
      await t.db.asOwner((pg) =>
        pg.query("update stores set status = 'inactive' where id = $1", [
          w.storeB,
        ]),
      );
      await anonymous(t).get('/public/storefronts/beta-shop').expect(404);
      await t.db.asOwner((pg) =>
        pg.query("update stores set status = 'active' where id = $1", [
          w.storeB,
        ]),
      );
      expect(await seo('beta-shop')).toMatchObject({
        metaTitle: 'Beta: gaming gear',
      });
    });
  },
);
