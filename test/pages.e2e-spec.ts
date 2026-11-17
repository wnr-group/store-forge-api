import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

describe.skipIf(!migrationsAvailable)('store content pages (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client;
  let bob: Client;
  let reader: Client;
  let pageId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
    reader = await as(t, w.members.reader);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  it('creates a draft page with an address made from the title', async () => {
    const res = await alice
      .post('/store/pages', { title: 'About us', body: 'Hello\n\nWorld' })
      .expect(201);
    expect(res.body.data).toMatchObject({
      title: 'About us',
      slug: 'about-us',
      status: 'draft',
    });
    pageId = res.body.data.id;
  });

  it('hides a draft from shoppers, then shows it once published', async () => {
    await anonymous(t)
      .get('/public/storefronts/alpha-shop/pages/about-us')
      .expect(404);
    const list = await anonymous(t)
      .get('/public/storefronts/alpha-shop/pages')
      .expect(200);
    expect(list.body.data).toEqual([]);

    await alice
      .patch(`/store/pages/${pageId}`, { status: 'published' })
      .expect(200);

    const page = await anonymous(t)
      .get('/public/storefronts/alpha-shop/pages/about-us')
      .expect(200);
    expect(page.body.data.page).toMatchObject({
      title: 'About us',
      body: 'Hello\n\nWorld',
    });
    expect(JSON.stringify(page.body.data)).not.toContain('tenant_id');
    const links = await anonymous(t)
      .get('/public/storefronts/alpha-shop/pages')
      .expect(200);
    expect(links.body.data).toEqual([{ title: 'About us', slug: 'about-us' }]);

    await alice
      .patch(`/store/pages/${pageId}`, { status: 'draft' })
      .expect(200);
    await anonymous(t)
      .get('/public/storefronts/alpha-shop/pages/about-us')
      .expect(404);
  });

  it('rejects duplicate and reserved addresses', async () => {
    await alice
      .post('/store/pages', { title: 'Another', slug: 'about-us' })
      .expect(409);
    await alice
      .post('/store/pages', { title: 'Products', slug: 'products' })
      .expect(400);
    await alice
      .post('/store/pages', { title: 'Bad', slug: 'Not A Slug!' })
      .expect(400);
  });

  it('lets another store use the same address without clashing', async () => {
    await bob.post('/store/pages', { title: 'About us' }).expect(201);
    const mine = (await alice.get('/store/pages').expect(200)).body.data;
    const theirs = (await bob.get('/store/pages').expect(200)).body.data;
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].id).not.toBe(theirs[0].id);
  });

  it("keeps one tenant out of another tenant's pages", async () => {
    const bobPage = (await bob.get('/store/pages').expect(200)).body.data[0];
    await alice.get(`/store/pages/${bobPage.id}`).expect(404);
    await alice
      .patch(`/store/pages/${bobPage.id}`, { title: 'Hacked' })
      .expect(404);
    await alice.delete(`/store/pages/${bobPage.id}`).expect(404);
    const still = await bob.get(`/store/pages/${bobPage.id}`).expect(200);
    expect(still.body.data.title).toBe('About us');
  });

  it('lets a reader see pages but not change them', async () => {
    await reader.get('/store/pages').expect(200);
    await reader.post('/store/pages', { title: 'Nope' }).expect(403);
    await reader.patch(`/store/pages/${pageId}`, { title: 'Nope' }).expect(403);
    await reader.delete(`/store/pages/${pageId}`).expect(403);
  });

  it('deletes a page and answers 404 afterwards', async () => {
    await alice.delete(`/store/pages/${pageId}`).expect(200);
    await alice.get(`/store/pages/${pageId}`).expect(404);
    await anonymous(t)
      .get('/public/storefronts/nowhere-shop/pages')
      .expect(404);
  });
});
