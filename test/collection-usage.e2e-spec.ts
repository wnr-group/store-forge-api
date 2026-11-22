import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Doc = { order: string[]; sections: Record<string, unknown> };
type Tpl = { id: string; revision: number; document: Doc };

describe.skipIf(!migrationsAvailable)(
  'collection usage and guarded delete (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let bob: Client;
    let reader: Client;
    let writer: Client;
    let nothing: Client;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);
      reader = await as(t, w.members.reader);
      writer = await as(t, w.members.writer);
      nothing = await as(t, w.members.nothing);
      await alice.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const home = async (): Promise<Tpl> => {
      const list = (await alice.get('/store/templates').expect(200)).body
        .data as { id: string; kind: string; isDefault: boolean }[];
      const row = list.find((x) => x.kind === 'index' && x.isDefault)!;
      return (await alice.get(`/store/templates/${row.id}`).expect(200)).body
        .data;
    };
    const collection = async (name: string) =>
      (await alice.post('/collections', { name, status: 'active' }).expect(201))
        .body.data as { id: string; slug: string };
    /** Save a draft whose extra Featured collection sections point at `refs` (one section per ref), or none. */
    const saveRefs = async (refs: string[]) => {
      const tpl = await home();
      const doc = structuredClone(tpl.document);
      for (const k of Object.keys(doc.sections))
        if (k.startsWith('usage')) delete doc.sections[k];
      doc.order = doc.order.filter((k) => !k.startsWith('usage'));
      refs.forEach((ref, i) => {
        doc.sections[`usage${i}`] = {
          type: 'featured-collection',
          settings: { collectionId: ref, title: `Usage ${i}` },
          blocks: {},
          block_order: [],
        };
        doc.order.push(`usage${i}`);
      });
      return (
        await alice
          .put(`/store/templates/${tpl.id}/draft`, {
            document: doc,
            expectedRevision: tpl.revision,
          })
          .expect(200)
      ).body.data as Tpl;
    };
    const publish = async () => {
      const tpl = await home();
      await alice
        .post(`/store/templates/${tpl.id}/publish`, {
          expectedRevision: tpl.revision,
        })
        .expect(200);
    };
    const usageOf = async (id: string) =>
      (await alice.get(`/collections/${id}/usage`).expect(200)).body.data as {
        total: number;
        hash: string;
        references: { inDraft: boolean; inPublished: boolean }[];
      };
    const exists = async (id: string) =>
      (await alice.get(`/collections/${id}`)).status === 200;

    it('an unused collection reports no usage and deletes without a hash', async () => {
      await saveRefs([]);
      const c = await collection('Unused One');
      expect(await usageOf(c.id)).toMatchObject({ total: 0, references: [] });
      await alice.delete(`/collections/${c.id}`).expect(200);
      expect(await exists(c.id)).toBe(false);
    });

    it('a draft reference by slug or id is reported; delete without the hash is refused (409) and changes nothing', async () => {
      const c = await collection('Draft Used');
      await saveRefs([c.slug, c.id]);
      const u = await usageOf(c.id);
      expect(u.total).toBe(2);
      expect(u.references.every((r) => r.inDraft && !r.inPublished)).toBe(true);
      const refused = await alice.delete(`/collections/${c.id}`).expect(409);
      expect(JSON.stringify(refused.body)).toContain('COLLECTION_IN_USE');
      await alice
        .delete(`/collections/${c.id}?usage=${'0'.repeat(64)}`)
        .expect(409);
      expect(await exists(c.id)).toBe(true);
    });

    it('a published reference is reported as live', async () => {
      const c = await collection('Live Used');
      await saveRefs([c.slug]);
      await publish();
      const u = await usageOf(c.id);
      expect(u.references[0]).toMatchObject({
        inDraft: true,
        inPublished: true,
      });
    });

    it('URLs or text that merely mention the collection are not references', async () => {
      const c = await collection('Mentioned Only');
      await saveRefs(['']);
      const tpl = await home();
      const doc = structuredClone(tpl.document);
      (
        doc.sections.usage0 as { settings: Record<string, unknown> }
      ).settings.title = `/collections/${c.slug}`;
      await alice
        .put(`/store/templates/${tpl.id}/draft`, {
          document: doc,
          expectedRevision: tpl.revision,
        })
        .expect(200);
      expect(await usageOf(c.id)).toMatchObject({ total: 0 });
      await alice.delete(`/collections/${c.id}`).expect(200);
    });

    it('delete succeeds with the current hash; a hash from before a change is refused; the design is left untouched', async () => {
      const c = await collection('Race Used');
      await saveRefs([c.id]);
      const before = await usageOf(c.id);
      await saveRefs([c.id, c.slug]);
      await alice
        .delete(`/collections/${c.id}?usage=${before.hash}`)
        .expect(409);
      const fresh = await usageOf(c.id);
      expect(fresh.hash).not.toBe(before.hash);
      await alice
        .delete(`/collections/${c.id}?usage=${fresh.hash}`)
        .expect(200);
      expect(await exists(c.id)).toBe(false);
      expect(JSON.stringify((await home()).document)).toContain(c.id);
    });

    it('a hash seen while the collection was used is refused once every reference is gone', async () => {
      const c = await collection('Cleared');
      await saveRefs([c.id]);
      const seen = await usageOf(c.id);
      await saveRefs([]);
      await alice.delete(`/collections/${c.id}?usage=${seen.hash}`).expect(409);
      await alice.delete(`/collections/${c.id}`).expect(200);
    });

    it('keeps the collection and its products when the delete is refused', async () => {
      const p = (
        await alice
          .post('/products', { name: 'Linked P', price: '3', status: 'active' })
          .expect(201)
      ).body.data;
      const c = (
        await alice
          .post('/collections', {
            name: 'Linked C',
            status: 'active',
            productIds: [p.id],
          })
          .expect(201)
      ).body.data;
      await saveRefs([c.slug]);
      await alice.delete(`/collections/${c.id}`).expect(409);
      expect(
        (await alice.get(`/collections/${c.id}`).expect(200)).body.data
          .productCount,
      ).toBe(1);
    });

    it('is tenant-scoped: another organization gets 404 for usage and delete', async () => {
      const c = await collection('Tenant A Only');
      await bob.get(`/collections/${c.id}/usage`).expect(404);
      await bob.delete(`/collections/${c.id}`).expect(404);
      expect(await exists(c.id)).toBe(true);
    });

    it('needs products write: write members can look up and delete, read-only and no-access members cannot', async () => {
      const c = await collection('Perm C');
      await saveRefs([]);
      for (const m of [reader, nothing]) {
        await m.get(`/collections/${c.id}/usage`).expect(403);
        await m.delete(`/collections/${c.id}`).expect(403);
      }
      await writer.get(`/collections/${c.id}/usage`).expect(200);
      await writer.delete(`/collections/${c.id}`).expect(200);
    });

    it('rejects a malformed usage value', async () => {
      const c = await collection('Bad Hash');
      await alice.delete(`/collections/${c.id}?usage=nothex`).expect(400);
    });
  },
);
