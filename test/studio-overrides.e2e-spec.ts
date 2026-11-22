import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Node = {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, Node>;
  block_order?: string[];
};
type Doc = {
  order: string[];
  sections: Record<string, Node>;
  [k: string]: unknown;
};

/** Studio AC-CFG-3: style (base/tablet/mobile, hidden), text and disable overrides survive draft -> publish -> storefront. */
describe.skipIf(!migrationsAvailable)('Studio overrides persist (e2e)', () => {
  let t: TestApp;
  let w: World;
  let owner: Client;
  let tplId = '';

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
    t = await createTestApp(db);
    owner = await as(t, w.alice);
    await owner.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    const list = (await owner.get('/store/templates').expect(200)).body
      .data as { id: string; kind: string; isDefault: boolean }[];
    tplId = list.find((x) => x.kind === 'index' && x.isDefault)!.id;
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const STYLE = {
    base: { hidden: true },
    tablet: { hidden: false, opacity: 80 },
    mobile: { hidden: true },
  };

  /** Every section and block of the home page gets the overrides, so the round trip covers each element type present. */
  const decorate = (doc: Doc) => {
    const touched: string[] = [];
    for (const [id, section] of Object.entries(doc.sections)) {
      section.settings = {
        ...section.settings,
        _style: STYLE,
        _text: [{ from: `ZZ-FROM-${id}`, to: `ZZ-TO-${id}` }],
      };
      touched.push(`${id}:${section.type}`);
      for (const [bid, block] of Object.entries(section.blocks ?? {})) {
        block.settings = { ...block.settings, _style: STYLE };
        touched.push(`${id}/${bid}:${block.type}`);
      }
    }
    return touched;
  };

  it('keeps style, hidden-per-device and text overrides on every element through save, publish and the public storefront', async () => {
    const d = (await owner.get(`/store/templates/${tplId}`).expect(200)).body
      .data as { document: Doc; revision: number };
    const doc = structuredClone(d.document);
    const touched = decorate(doc);
    expect(touched.length).toBeGreaterThan(3);

    const saved = (
      await owner
        .put(`/store/templates/${tplId}/draft`, {
          document: doc,
          expectedRevision: d.revision,
        })
        .expect(200)
    ).body.data as { document: Doc; revision: number };
    expect(saved.document).toEqual(doc);

    const reread = (await owner.get(`/store/templates/${tplId}`).expect(200))
      .body.data as { document: Doc };
    expect(reread.document).toEqual(doc);

    await owner
      .post(`/store/templates/${tplId}/publish`, {
        expectedRevision: saved.revision,
      })
      .expect(200);

    const live = (
      await anonymous(t)
        .get('/public/storefronts/alpha-shop/layout?kind=index')
        .expect(200)
    ).body.data.template.document as Doc;
    expect(live).toEqual(doc);
    for (const [id, section] of Object.entries(live.sections)) {
      expect(section.settings?._style).toEqual(STYLE);
      expect(section.settings?._text).toEqual([
        { from: `ZZ-FROM-${id}`, to: `ZZ-TO-${id}` },
      ]);
      for (const block of Object.values(section.blocks ?? {}))
        expect(block.settings?._style).toEqual(STYLE);
    }
  });

  it('refuses a stale save (409) and keeps the published overrides', async () => {
    const d = (await owner.get(`/store/templates/${tplId}`).expect(200)).body
      .data as { document: Doc; revision: number };
    await owner
      .put(`/store/templates/${tplId}/draft`, {
        document: d.document,
        expectedRevision: d.revision - 1,
      })
      .expect(409);
    const live = (
      await anonymous(t)
        .get('/public/storefronts/alpha-shop/layout?kind=index')
        .expect(200)
    ).body.data.template.document as Doc;
    expect(Object.values(live.sections)[0].settings?._style).toEqual(STYLE);
  });
});
