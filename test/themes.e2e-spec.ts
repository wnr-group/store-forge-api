import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { rowsOf } from '../src/database/database.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Template = {
  id: string;
  kind: string;
  revision: number;
  publicationState: string;
  isDefault: boolean;
  document?: Record<string, unknown>;
};

/** What shoppers get: the database function behind the public storefront. */
async function liveLayout(t: TestApp, slug: string, kind = 'index') {
  const rows = await t.db.service.withPublic(async (tx) =>
    rowsOf<{ layout: Record<string, unknown> | null }>(
      await tx.execute(
        sql`select public.get_public_template_layout(${slug}, ${kind}) as layout`,
      ),
    ),
  );
  return rows[0]!.layout;
}

describe.skipIf(!migrationsAvailable)('themes and store design (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client;
  let bob: Client;

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

  const templatesOf = async (c: Client): Promise<Template[]> =>
    (await c.get('/store/templates').expect(200)).body.data;
  const byKind = (list: Template[], kind: string) =>
    list.find((x) => x.kind === kind && (x.isDefault || kind.includes('_')))!;

  describe('theme catalogue', () => {
    it('lists the six themes, paginated, with the same content for every tenant', async () => {
      const a = await alice.get('/themes').expect(200);
      expect(a.body.data).toHaveLength(6);
      expect(a.body.meta).toMatchObject({ page: 1, total: 6 });
      expect(a.body.data[0]).not.toHaveProperty('documents');
      const b = await bob.get('/themes').expect(200);
      expect(b.body.data.map((x: { slug: string }) => x.slug)).toEqual(
        a.body.data.map((x: { slug: string }) => x.slug),
      );

      const page = await alice.get('/themes?limit=2&page=2').expect(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 6 });
    });

    it('filters by industry and searches by name', async () => {
      const beauty = await alice.get('/themes?industry=beauty').expect(200);
      expect(beauty.body.data.map((x: { slug: string }) => x.slug)).toEqual([
        'lumiere',
      ]);
      const found = await alice.get('/themes?search=grocery').expect(200);
      expect(found.body.data.map((x: { slug: string }) => x.slug)).toEqual([
        'freshly',
      ]);
      await alice.get('/themes?industry=toys').expect(400);
    });

    it('previews one theme with its documents, and 404s for an unknown one', async () => {
      const res = await alice.get('/themes/voltage').expect(200);
      expect(Object.keys(res.body.data.documents).sort()).toEqual([
        'collection',
        'group_announcement',
        'group_footer',
        'group_header',
        'index',
        'product',
        'theme_settings',
      ]);
      await alice.get('/themes/nope').expect(404);
    });

    it('needs a signed-in member of an organization', async () => {
      const carol = await as(t, w.carol);
      await carol.get('/themes').expect(404);
    });
  });

  describe('applying a theme', () => {
    it('refuses members without write access to store settings', async () => {
      const reader = await as(t, w.members.reader, w.tenantA);
      await reader.post('/store/theme', { themeSlug: 'atelier' }).expect(403);
      await reader.get('/themes').expect(200);
    });

    it('rejects an unknown theme and bad input', async () => {
      await alice.post('/store/theme', { themeSlug: 'nope' }).expect(404);
      await alice.post('/store/theme', { themeSlug: '../x' }).expect(400);
      await alice.post('/store/theme', {}).expect(400);
    });

    it('has no theme before one is applied', async () => {
      const res = await alice.get('/store/theme').expect(200);
      expect(res.body.data).toMatchObject({
        theme: null,
        updateAvailable: false,
      });
    });

    it('copies the theme into drafts only, leaves commerce data alone and goes nowhere live', async () => {
      const product = await alice
        .post('/products', {
          name: 'Linen Shirt',
          price: '999',
          status: 'active',
        })
        .expect(201);
      const before = await alice.get('/products').expect(200);

      const res = await alice
        .post('/store/theme', { themeSlug: 'atelier' })
        .expect(200);
      expect(res.body.data).toMatchObject({
        draftsWritten: 7,
        draftsReplaced: 0,
        theme: { slug: 'atelier', isCurrent: true },
      });

      const list = await templatesOf(alice);
      expect(list).toHaveLength(7);
      expect(list.every((x) => x.publicationState === 'draft')).toBe(true);

      const after = await alice.get('/products').expect(200);
      expect(after.body.meta.total).toBe(before.body.meta.total);
      await alice.get(`/products/${product.body.data.id}`).expect(200);

      // Not published: shoppers still get no engine template.
      const live = await liveLayout(t, 'alpha-shop');
      expect(live?.template ?? null).toBeNull();

      const current = await alice.get('/store/theme').expect(200);
      expect(current.body.data).toMatchObject({
        theme: { slug: 'atelier' },
        appliedVersion: 1,
        updateAvailable: false,
      });
      const catalogue = await alice.get('/themes').expect(200);
      expect(
        catalogue.body.data
          .filter((x: { isCurrent: boolean }) => x.isCurrent)
          .map((x: { slug: string }) => x.slug),
      ).toEqual(['atelier']);
    });

    it('lets different tenants pick different themes independently', async () => {
      await bob.post('/store/theme', { themeSlug: 'voltage' }).expect(200);
      expect(
        (await bob.get('/store/theme').expect(200)).body.data.theme.slug,
      ).toBe('voltage');
      expect(
        (await alice.get('/store/theme').expect(200)).body.data.theme.slug,
      ).toBe('atelier');
      const a = byKind(await templatesOf(alice), 'index');
      const b = byKind(await templatesOf(bob), 'index');
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('drafts', () => {
    let page: Template;

    beforeAll(async () => {
      page = (
        await alice.get(
          `/store/templates/${byKind(await templatesOf(alice), 'index').id}`,
        )
      ).body.data;
    });

    it('saves a text change, bumps the revision and keeps it unpublished', async () => {
      const doc = structuredClone(page.document!) as {
        sections: Record<string, { settings: Record<string, unknown> }>;
      };
      doc.sections.campaign!.settings.heading = 'A New Heading';
      const res = await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: doc,
          expectedRevision: page.revision,
        })
        .expect(200);
      expect(res.body.data.revision).toBe(page.revision + 1);
      expect(
        (res.body.data.document as typeof doc).sections.campaign!.settings
          .heading,
      ).toBe('A New Heading');
      expect(res.body.data.publicationState).toBe('draft');
      page = res.body.data;

      const reread = await alice.get(`/store/templates/${page.id}`).expect(200);
      expect(reread.body.data.document).toEqual(res.body.data.document);
    });

    it('does not move the revision when nothing changed', async () => {
      const res = await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: page.document,
          expectedRevision: page.revision,
        })
        .expect(200);
      expect(res.body.data.revision).toBe(page.revision);
    });

    it('detects concurrent edits with 409 and writes nothing', async () => {
      const res = await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: page.document,
          expectedRevision: page.revision - 1,
        })
        .expect(409);
      expect(res.body.error.code).toBe('TEMPLATE_REVISION_CONFLICT');
    });

    it('can add, remove and reorder sections', async () => {
      const doc = structuredClone(page.document!) as {
        sections: Record<string, unknown>;
        order: string[];
      };
      doc.sections.extra = {
        type: 'rich-text',
        settings: { alignment: 'center' },
        blocks: {},
        block_order: [],
      };
      doc.order = ['extra', ...doc.order.filter((id) => id !== 'sale')];
      delete doc.sections.sale;
      const res = await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: doc,
          expectedRevision: page.revision,
        })
        .expect(200);
      expect(res.body.data.document.order[0]).toBe('extra');
      expect(res.body.data.document.sections.sale).toBeUndefined();
      page = res.body.data;
    });

    it('rejects invalid documents with field-level errors and stores nothing', async () => {
      const bad = structuredClone(page.document!) as {
        sections: Record<string, { settings: Record<string, unknown> }>;
      };
      bad.sections.campaign!.settings.accentColor = 'red';
      bad.sections.extra!.settings.link = 'javascript:alert(1)';
      const res = await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: bad,
          expectedRevision: page.revision,
        })
        .expect(400);
      expect(res.body.error.code).toBe('TEMPLATE_DOCUMENT_INVALID');
      expect(Object.keys(res.body.error.details)).toEqual(
        expect.arrayContaining([
          'index.sections.campaign.settings.accentColor',
          'index.sections.extra.settings.link',
        ]),
      );
      const same = await alice.get(`/store/templates/${page.id}`).expect(200);
      expect(same.body.data.revision).toBe(page.revision);
    });

    it("rejects another organization's images and a missing revision", async () => {
      const doc = structuredClone(page.document!) as {
        sections: Record<string, { settings: Record<string, unknown> }>;
      };
      doc.sections.campaign!.settings.image = {
        path: `${w.tenantB}/store/stolen.jpg`,
      };
      await alice
        .put(`/store/templates/${page.id}/draft`, {
          document: doc,
          expectedRevision: page.revision,
        })
        .expect(400);
      await alice
        .put(`/store/templates/${page.id}/draft`, { document: page.document })
        .expect(400);
    });

    it('serves an authorised preview of the draft with theme settings and groups', async () => {
      const res = await alice
        .get(`/store/templates/${page.id}/preview`)
        .expect(200);
      expect(res.body.data.template.document).toEqual(page.document);
      expect(res.body.data.theme.settings.colors.primary).toBe('#171717');
      expect(Object.keys(res.body.data.groups).sort()).toEqual([
        'announcement',
        'footer',
        'header',
      ]);
      expect(res.body.data.storeSlug).toBe('alpha-shop');
      expect((await liveLayout(t, 'alpha-shop'))?.template ?? null).toBeNull();
    });

    it('lets read-only members read drafts but not change them', async () => {
      const reader = await as(t, w.members.reader, w.tenantA);
      await reader.get(`/store/templates/${page.id}`).expect(200);
      await reader
        .put(`/store/templates/${page.id}/draft`, {
          document: page.document,
          expectedRevision: page.revision,
        })
        .expect(403);
      await reader.post(`/store/templates/${page.id}/publish`, {}).expect(403);
    });
  });

  describe('publishing and rollback', () => {
    let index: Template;

    beforeAll(async () => {
      index = byKind(await templatesOf(alice), 'index');
    });

    it('publishes the whole theme atomically and shoppers see it', async () => {
      const res = await alice
        .post('/store/theme/publish', { label: 'Launch' })
        .expect(200);
      expect(res.body.data.published).toHaveLength(7);
      expect(res.body.data.storeSlug).toBe('alpha-shop');

      const list = await templatesOf(alice);
      expect(list.every((x) => x.publicationState === 'published')).toBe(true);

      const live = await liveLayout(t, 'alpha-shop');
      expect(live).toMatchObject({ source: 'default' });
      const template = live!.template as {
        version_number: number;
        document: {
          sections: Record<string, { settings: { heading?: string } }>;
        };
      };
      expect(template.version_number).toBe(1);
      expect(template.document.sections.campaign!.settings.heading).toBe(
        'A New Heading',
      );
      expect(
        (live!.theme as { settings: { colors: { primary: string } } }).settings
          .colors.primary,
      ).toBe('#171717');
      expect(live!.groups).toMatchObject({ header: expect.anything() });

      // Other tenants are unaffected.
      expect((await liveLayout(t, 'beta-shop'))?.template ?? null).toBeNull();
    });

    it('publishing again with no changes creates no new version', async () => {
      const res = await alice.post('/store/theme/publish', {}).expect(200);
      expect(res.body.data.published).toEqual([]);
      expect(res.body.data.unchanged).toBe(7);
    });

    it('keeps edits as drafts until they are published', async () => {
      const current = (
        await alice.get(`/store/templates/${index.id}`).expect(200)
      ).body.data as Template;
      const doc = structuredClone(current.document!) as {
        sections: Record<string, { settings: Record<string, unknown> }>;
      };
      doc.sections.campaign!.settings.heading = 'Second Edit';
      const saved = await alice
        .put(`/store/templates/${index.id}/draft`, {
          document: doc,
          expectedRevision: current.revision,
        })
        .expect(200);
      expect(saved.body.data.publicationState).toBe('published_with_changes');
      const live = (await liveLayout(t, 'alpha-shop'))!.template as {
        document: {
          sections: Record<string, { settings: { heading?: string } }>;
        };
      };
      expect(live.document.sections.campaign!.settings.heading).toBe(
        'A New Heading',
      );

      const stale = await alice
        .post(`/store/templates/${index.id}/publish`, {
          expectedRevision: current.revision,
        })
        .expect(409);
      expect(stale.body.error.code).toBe('TEMPLATE_REVISION_CONFLICT');

      const res = await alice
        .post(`/store/templates/${index.id}/publish`, {
          label: 'Second',
          expectedRevision: saved.body.data.revision,
        })
        .expect(200);
      expect(res.body.data.published[0]).toMatchObject({
        kind: 'index',
        versionNumber: 2,
      });
    });

    it('lists history and restores an earlier version as a new one, leaving commerce data alone', async () => {
      const versions = (
        await alice.get(`/store/templates/${index.id}/versions`).expect(200)
      ).body.data as {
        id: string;
        versionNumber: number;
        isLive: boolean;
        source: string;
      }[];
      expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(versions[0]!.isLive).toBe(true);

      const productsBefore = (await alice.get('/products').expect(200)).body
        .meta.total;
      const first = versions.find((v) => v.versionNumber === 1)!;
      const res = await alice
        .post(`/store/templates/${index.id}/rollback`, { versionId: first.id })
        .expect(200);
      expect(res.body.data.published[0]).toMatchObject({ versionNumber: 3 });

      const live = (await liveLayout(t, 'alpha-shop'))!.template as {
        version_number: number;
        document: {
          sections: Record<string, { settings: { heading?: string } }>;
        };
      };
      expect(live.version_number).toBe(3);
      expect(live.document.sections.campaign!.settings.heading).toBe(
        'A New Heading',
      );

      const after = (
        await alice.get(`/store/templates/${index.id}/versions`).expect(200)
      ).body.data as {
        id: string;
        versionNumber: number;
        source: string;
        rolledBackFrom: string | null;
        isLive: boolean;
      }[];
      expect(after).toHaveLength(3);
      expect(after[0]).toMatchObject({
        versionNumber: 3,
        source: 'rollback',
        rolledBackFrom: first.id,
        isLive: true,
      });

      const draft = (
        await alice.get(`/store/templates/${index.id}`).expect(200)
      ).body.data;
      expect(draft.publicationState).toBe('published');
      expect((await alice.get('/products').expect(200)).body.meta.total).toBe(
        productsBefore,
      );

      await alice
        .post(`/store/templates/${index.id}/rollback`, {
          versionId: after[0]!.id,
        })
        .expect(409);
      await alice
        .post(`/store/templates/${index.id}/rollback`, {
          versionId: randomUUID(),
        })
        .expect(400);
    });

    it('switching to another theme keeps published pages live until the new one is published', async () => {
      const liveBefore = await liveLayout(t, 'alpha-shop');
      const res = await alice
        .post('/store/theme', { themeSlug: 'plain' })
        .expect(200);
      expect(res.body.data.draftsReplaced).toBeGreaterThan(0);
      expect(await liveLayout(t, 'alpha-shop')).toEqual(liveBefore);
      expect(
        (await alice.get('/products').expect(200)).body.meta.total,
      ).toBeGreaterThan(0);

      await alice.post('/store/theme/publish', {}).expect(200);
      const now = (await liveLayout(t, 'alpha-shop'))!.template as {
        document: { order: string[] };
      };
      expect(now.document.order).toEqual(['intro', 'products']);
    });
  });

  describe('tenant isolation', () => {
    let bobIndex: Template;

    beforeAll(async () => {
      bobIndex = byKind(await templatesOf(bob), 'index');
    });

    it('shows each tenant only its own pages', async () => {
      const a = await templatesOf(alice);
      const b = await templatesOf(bob);
      const aIds = new Set(a.map((x) => x.id));
      expect(b.some((x) => aIds.has(x.id))).toBe(false);
    });

    it("hides another tenant's page, preview, history and versions behind 404", async () => {
      await alice.get(`/store/templates/${bobIndex.id}`).expect(404);
      await alice.get(`/store/templates/${bobIndex.id}/preview`).expect(404);
      await alice.get(`/store/templates/${bobIndex.id}/versions`).expect(404);
    });

    it("cannot save, publish or restore another tenant's page", async () => {
      const own = await bob.get(`/store/templates/${bobIndex.id}`).expect(200);
      await alice
        .put(`/store/templates/${bobIndex.id}/draft`, {
          document: own.body.data.document,
          expectedRevision: own.body.data.revision,
        })
        .expect(404);
      await alice
        .post(`/store/templates/${bobIndex.id}/publish`, {})
        .expect(404);
      await alice
        .post(`/store/templates/${bobIndex.id}/rollback`, {
          versionId: randomUUID(),
        })
        .expect(404);
      const unchanged = await bob
        .get(`/store/templates/${bobIndex.id}`)
        .expect(200);
      expect(unchanged.body.data.revision).toBe(own.body.data.revision);
      expect((await liveLayout(t, 'beta-shop'))?.template ?? null).toBeNull();
    });

    it('ignores a forged organization header', async () => {
      const forged = await as(t, w.alice, w.tenantB);
      await forged.get(`/store/templates/${bobIndex.id}`).expect(403);
      await forged.post('/store/theme', { themeSlug: 'plain' }).expect(403);
    });

    it('is blocked by row level security even when the service is bypassed', async () => {
      // Run the exact statements the API would run, as Alice, against Bob's rows.
      const asAlice = await t.db.service.withUser(w.alice, async (tx) => {
        const rows = await tx.execute(
          `select id from public.templates where tenant_id = '${w.tenantB}'` as never,
        );
        return (
          (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[])
        );
      });
      expect(asAlice).toHaveLength(0);
    });

    it('requires authentication', async () => {
      const { anonymous } = await import('./support/app.js');
      await anonymous(t).get('/themes').expect(401);
      await anonymous(t).get(`/store/templates/${bobIndex.id}`).expect(401);
    });
  });
});
