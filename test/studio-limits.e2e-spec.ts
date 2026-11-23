import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

/** Studio AC-NFR-1: the existing document and list limits still hold with the Studio changes in place. */
describe.skipIf(!migrationsAvailable)(
  'existing limits still hold (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let tplId = '';

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      await alice.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
      const list = (await alice.get('/store/templates').expect(200)).body
        .data as { id: string; kind: string; isDefault: boolean }[];
      tplId = list.find((x) => x.kind === 'index' && x.isDefault)!.id;
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    it('refuses a page with more than 25 sections', async () => {
      const d = (await alice.get(`/store/templates/${tplId}`).expect(200)).body
        .data as {
        document: { order: string[]; sections: Record<string, unknown> };
        revision: number;
      };
      const doc = structuredClone(d.document);
      for (let i = 0; i < 30; i++) {
        doc.sections[`many${i}`] = {
          type: 'rich-text',
          settings: {},
          blocks: {},
          block_order: [],
        };
        doc.order.push(`many${i}`);
      }
      const res = await alice
        .put(`/store/templates/${tplId}/draft`, {
          document: doc,
          expectedRevision: d.revision,
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/section/i);
    });

    it('refuses a collection with more than 500 products (create and update)', async () => {
      const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
      await alice
        .post('/collections', {
          name: 'Too many',
          status: 'active',
          productIds: ids,
        })
        .expect(400);
      const made = (
        await alice
          .post('/collections', { name: 'Fine', status: 'active' })
          .expect(201)
      ).body.data as { id: string };
      await alice
        .patch(`/collections/${made.id}`, { productIds: ids })
        .expect(400);
    });

    it('refuses an unknown or malformed usage hash on collection delete instead of deleting', async () => {
      const made = (
        await alice
          .post('/collections', { name: 'Hash check', status: 'active' })
          .expect(201)
      ).body.data as { id: string };
      await alice
        .delete(`/collections/${made.id}?usage=not-a-hash`)
        .expect(400);
      await alice.get(`/collections/${made.id}`).expect(200);
    });
  },
);
