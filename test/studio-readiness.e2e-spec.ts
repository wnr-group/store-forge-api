import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  createTestDb,
  createUser,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Issue = {
  key: string;
  ruleId: string;
  severity: string;
  message: string;
  target: { documentId: string; nodeId: string | null };
  fixAction: string;
  controlPath: string;
};
type Report = {
  issues: Issue[];
  counts: { blockers: number; warnings: number; information: number };
  canPublish: boolean;
  enforced: boolean;
};
type Doc = Record<string, unknown> & {
  sections: Record<string, unknown>;
  order: string[];
};

const perms = (design: 'none' | 'read' | 'write' | 'publish') => ({
  products: 'read',
  orders: 'none',
  customers: 'none',
  settings: 'read',
  design,
});

/** Publish readiness (framework + publish integration), including the "Studio off changes nothing" regression. */
describe.skipIf(!migrationsAvailable)('studio readiness (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client; // owner of A
  let bob: Client; // owner of B
  let adminC: Client;
  const members: Record<string, Client> = {};
  let indexId = '';
  let baseDraft: Doc;

  const count = (table: string, where = '') =>
    t.db.asOwner(async (pg) =>
      Number(
        (
          await pg.query<{ n: string }>(
            `select count(*) n from ${table} ${where}`,
          )
        ).rows[0].n,
      ),
    );
  const versions = () => count('template_versions');
  const publishes = (tenant?: string) =>
    count('studio_publishes', tenant ? `where tenant_id = '${tenant}'` : '');

  const setRollout = (tenant: string, enabled: boolean) =>
    adminC
      .put(`/platform/organizations/${tenant}/studio-rollout`, {
        enabled,
        reason: 'readiness test',
      })
      .expect(200);

  /** Privileged write of a draft, so the test can store content the editor would not normally produce. */
  const setDraft = (id: string, doc: unknown) =>
    t.db.asOwner((pg) =>
      pg.query('update templates set draft = $1::jsonb where id = $2', [
        JSON.stringify(doc),
        id,
      ]),
    );
  const withSection = (id: string, section: unknown): Doc => ({
    ...baseDraft,
    sections: { ...baseDraft.sections, [id]: section },
    order: [...baseDraft.order, id],
  });
  const richText = (
    settings: Record<string, unknown>,
    blocks: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'rich-text',
    settings,
    blocks,
    block_order: Object.keys(blocks),
    ...extra,
  });
  const imageBlock = (alt?: string) => ({
    type: 'image',
    settings: {
      image: { path: `${w.tenantA}/store/x.jpg`, ...(alt ? { alt } : {}) },
    },
    blocks: {},
    block_order: [],
  });
  const unknownContrast = { _style: { base: { color: '#000000' } } };

  const report = async (c: Client = alice, body: object = {}) =>
    (await c.post('/store/studio/readiness', body).expect(200)).body
      .data as Report;
  const ids = (r: Report, severity?: string) =>
    r.issues
      .filter((i) => !severity || i.severity === severity)
      .map((i) => i.ruleId);

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
    adminC = await as(t, w.admin);
    for (const level of ['none', 'read', 'write', 'publish'] as const) {
      const id = await createUser(db, `${level}@readiness.test`, level);
      await db.asOwner((pg) =>
        pg.query(
          "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin',$3::jsonb,'active')",
          [w.tenantA, id, JSON.stringify(perms(level))],
        ),
      );
      members[level] = await as(t, id, w.tenantA);
    }
    await alice.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    await bob.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    const list = (await alice.get('/store/templates').expect(200)).body
      .data as { id: string; kind: string; isDefault: boolean }[];
    indexId = list.find((x) => x.kind === 'index' && x.isDefault)!.id;
    baseDraft = (await alice.get(`/store/templates/${indexId}`).expect(200))
      .body.data.document;
    // The catalogue theme ships images without alt text (a real finding: the rule blocks them for a Studio store).
    // Give them alt text so the tests start from a clean document.
    const addAlt = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(addAlt);
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (('path' in o || 'asset' in o) && !o.alt) o.alt = 'Test image';
      Object.values(o).forEach(addAlt);
    };
    addAlt(baseDraft);
    await setDraft(indexId, baseDraft);
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  describe('POST /store/studio/readiness', () => {
    it('returns an ordered report with counts, fix action and control path', async () => {
      await setDraft(
        indexId,
        withSection(
          'bad',
          richText({}, { img: imageBlock() }, { display: { v: 1, rules: [] } }),
        ),
      );
      await setDraft(
        indexId,
        withSection('warn', richText(unknownContrast, { img: imageBlock() })),
      );
      const r = await report();
      expect(r.enforced).toBe(false);
      expect(r.canPublish).toBe(false);
      expect(r.counts.blockers).toBeGreaterThanOrEqual(1);
      expect(r.counts.warnings).toBeGreaterThanOrEqual(1);
      // Blockers come before warnings.
      const severities = r.issues.map((i) => i.severity);
      expect(severities).toEqual([...severities].sort());
      const alt = r.issues.find((i) => i.ruleId === 'media.alt.missing')!;
      expect(alt).toMatchObject({
        severity: 'BLOCKER',
        target: { documentId: indexId, nodeId: 'img' },
        fixAction: 'add_alt_text',
        controlPath: 'settings.image.alt',
      });
      expect(
        r.issues.find((i) => i.ruleId === 'a11y.contrast.unknown'),
      ).toMatchObject({
        severity: 'WARNING',
        target: { documentId: indexId, nodeId: 'warn' },
      });
    });

    it('reads display rules and the server clock', async () => {
      const display = {
        v: 1,
        rules: [
          {
            type: 'schedule',
            startsAt: '2020-01-01T00:00:00Z',
            endsAt: '2020-02-01T00:00:00Z',
          },
          { type: 'device', desktop: false, tablet: false, mobile: false },
        ],
      };
      const order = {
        v: 1,
        rules: [
          {
            type: 'schedule',
            startsAt: '2030-02-01T00:00:00Z',
            endsAt: '2030-01-01T00:00:00Z',
          },
        ],
      };
      await setDraft(indexId, withSection('x', richText({}, {}, { display })));
      expect(ids(await report())).toEqual(
        expect.arrayContaining([
          'display.schedule.all-expired',
          'display.device.none',
        ]),
      );
      await setDraft(
        indexId,
        withSection('x', richText({}, {}, { display: order })),
      );
      expect(ids(await report())).toContain('display.schedule.order');
      await setDraft(
        indexId,
        withSection('x', richText({}, {}, { display: { v: 9 } })),
      );
      expect(ids(await report(), 'BLOCKER')).toContain(
        'display.schedule.invalid',
      );
    });

    it('can be limited to one document, and an unknown or foreign document is a 404', async () => {
      await setDraft(indexId, withSection('warn', richText(unknownContrast)));
      const one = await report(alice, { templateId: indexId });
      expect(new Set(one.issues.map((i) => i.target.documentId))).toEqual(
        new Set([indexId]),
      );
      await alice
        .post('/store/studio/readiness', {
          templateId: '00000000-0000-4000-8000-000000000000',
        })
        .expect(404);
      await alice
        .post('/store/studio/readiness', { templateId: 'nope' })
        .expect(400);
      const bobTemplate = (
        (await bob.get('/store/templates').expect(200)).body.data as {
          id: string;
        }[]
      )[0].id;
      await alice
        .post('/store/studio/readiness', { templateId: bobTemplate })
        .expect(404);
    });

    it('needs design:view: read, write and publish may call it, none may not', async () => {
      await members.none.post('/store/studio/readiness', {}).expect(403);
      for (const level of ['read', 'write', 'publish'])
        await members[level].post('/store/studio/readiness', {}).expect(200);
    });

    it('is tenant isolated: each store sees only its own documents', async () => {
      await setDraft(indexId, withSection('warn', richText(unknownContrast)));
      const a = await report(alice);
      const b = await report(bob);
      const bobDocs = new Set(b.issues.map((i) => i.target.documentId));
      expect(a.issues.some((i) => i.target.documentId === indexId)).toBe(true);
      expect(bobDocs.has(indexId)).toBe(false);
      expect(
        b.issues.some(
          (i) =>
            i.ruleId === 'a11y.contrast.unknown' && i.target.nodeId === 'warn',
        ),
      ).toBe(false);
    });

    it('is not a write: nothing is created by asking', async () => {
      const [v, p] = [await versions(), await publishes()];
      await report();
      expect([await versions(), await publishes()]).toEqual([v, p]);
    });
  });

  describe('Studio off: publish is exactly as before', () => {
    it('publishes a document with a blocker and warnings, records no studio_publishes row, ignores acknowledgedWarnings', async () => {
      await setDraft(
        indexId,
        withSection('s', richText(unknownContrast, { img: imageBlock() })),
      );
      const before = await publishes();
      const r = await report();
      expect(r.enforced).toBe(false);
      expect(r.counts.blockers).toBeGreaterThan(0);
      const res = await alice
        .post('/store/theme/publish', { label: 'off' })
        .expect(200);
      expect(res.body.data.published.length).toBeGreaterThan(0);
      expect(await publishes()).toBe(before);
      // The single-page route too.
      await setDraft(
        indexId,
        withSection('s2', richText(unknownContrast, { img: imageBlock() })),
      );
      await alice
        .post(`/store/templates/${indexId}/publish`, {
          acknowledgedWarnings: ['x'],
        })
        .expect(200);
      expect(await publishes()).toBe(before);
    });
  });

  describe('Studio on: the publish gate', () => {
    beforeAll(async () => {
      await setRollout(w.tenantA, true);
    });

    it('refuses blockers with the issue list, writes nothing, and cannot be overridden', async () => {
      await setDraft(
        indexId,
        withSection('s', richText({}, { img: imageBlock() })),
      );
      const [v, p] = [await versions(), await publishes()];
      const r = await report();
      expect(r.enforced).toBe(true);
      const blocker = r.issues.find((i) => i.severity === 'BLOCKER')!;

      const res = await alice.post('/store/theme/publish', {}).expect(400);
      expect(res.body.error.code).toBe('READINESS_BLOCKED');
      expect(res.body.error.details.counts.blockers).toBeGreaterThan(0);
      expect(
        res.body.error.details.issues.map((i: Issue) => i.ruleId),
      ).toContain('media.alt.missing');

      // Acknowledging a blocker (or everything) changes nothing.
      const all = r.issues.map((i) => i.key);
      for (const ack of [[blocker.key], all]) {
        const again = await alice
          .post('/store/theme/publish', { acknowledgedWarnings: ack })
          .expect(400);
        expect(again.body.error.code).toBe('READINESS_BLOCKED');
        const one = await alice
          .post(`/store/templates/${indexId}/publish`, {
            acknowledgedWarnings: ack,
          })
          .expect(400);
        expect(one.body.error.code).toBe('READINESS_BLOCKED');
      }
      expect([await versions(), await publishes()]).toEqual([v, p]);
    });

    it('a document the validator rejects is a blocker (doc.invalid-config) and nothing is written', async () => {
      await setDraft(indexId, { ...baseDraft, layout: 'fancy' });
      const [v, p] = [await versions(), await publishes()];
      const res = await alice.post('/store/theme/publish', {}).expect(400);
      expect(res.body.error.code).toBe('READINESS_BLOCKED');
      expect(
        res.body.error.details.issues.map((i: Issue) => i.ruleId),
      ).toContain('doc.invalid-config');
      expect([await versions(), await publishes()]).toEqual([v, p]);
    });

    it('warnings need acknowledgement; unacknowledged is refused with nothing written, acknowledged publishes and is stored', async () => {
      await setDraft(indexId, withSection('w', richText(unknownContrast)));
      const [v, p] = [await versions(), await publishes()];
      const r = await report();
      expect(r.counts.blockers).toBe(0);
      const warnings = r.issues.filter((i) => i.severity === 'WARNING');
      expect(warnings.length).toBeGreaterThan(0);

      const refused = await alice.post('/store/theme/publish', {}).expect(400);
      expect(refused.body.error.code).toBe(
        'READINESS_ACKNOWLEDGEMENT_REQUIRED',
      );
      expect(refused.body.error.details.issues.length).toBe(warnings.length);
      const partial = await alice
        .post('/store/theme/publish', {
          acknowledgedWarnings: ['not-a-real-key'],
        })
        .expect(400);
      expect(partial.body.error.code).toBe(
        'READINESS_ACKNOWLEDGEMENT_REQUIRED',
      );
      expect([await versions(), await publishes()]).toEqual([v, p]);

      const ok = await alice
        .post('/store/theme/publish', {
          label: 'studio',
          acknowledgedWarnings: warnings.map((i) => i.key),
        })
        .expect(200);
      expect(ok.body.data.published.length).toBeGreaterThan(0);
      expect(await versions()).toBeGreaterThan(v);
      expect(await publishes()).toBe(p + 1);

      const row = await t.db.asOwner(
        async (pg) =>
          (
            await pg.query<{
              published_by: string;
              items: { templateId: string }[];
              warning_acknowledgements: { key: string; ruleId: string }[];
              readiness_summary: {
                counts: { warnings: number; blockers: number };
              };
              studio_schema_version: number;
              tenant_id: string;
            }>(
              'select * from studio_publishes where tenant_id = $1 order by published_at desc limit 1',
              [w.tenantA],
            )
          ).rows[0],
      );
      expect(row.published_by).toBe(w.alice);
      expect(row.studio_schema_version).toBe(2);
      expect(row.items.some((i) => i.templateId === indexId)).toBe(true);
      expect(row.warning_acknowledgements.map((a) => a.key).sort()).toEqual(
        warnings.map((i) => i.key).sort(),
      );
      expect(row.warning_acknowledgements[0].ruleId).toBe(
        'a11y.contrast.unknown',
      );
      expect(row.readiness_summary.counts).toMatchObject({ blockers: 0 });
      expect(row.readiness_summary.counts.warnings).toBe(warnings.length);
    });

    it('a document that already matches live is not re-checked: publishing again needs no acknowledgement', async () => {
      const p = await publishes();
      const res = await alice.post('/store/theme/publish', {}).expect(200);
      expect(res.body.data.published).toEqual([]);
      expect(await publishes()).toBe(p);
    });

    it('the single page route enforces the same gate and records its own row', async () => {
      await setDraft(
        indexId,
        withSection('one', richText(unknownContrast, { i: imageBlock() })),
      );
      const [v, p] = [await versions(), await publishes()];
      const blocked = await alice
        .post(`/store/templates/${indexId}/publish`, {})
        .expect(400);
      expect(blocked.body.error.code).toBe('READINESS_BLOCKED');
      expect([await versions(), await publishes()]).toEqual([v, p]);

      await setDraft(
        indexId,
        withSection(
          'one',
          richText(unknownContrast, { i: imageBlock('A shirt') }),
        ),
      );
      const r = await report(alice, { templateId: indexId });
      expect(r.counts.blockers).toBe(0);
      const warnings = r.issues.map((i) => i.key);
      const need = await alice
        .post(`/store/templates/${indexId}/publish`, {})
        .expect(400);
      expect(need.body.error.code).toBe('READINESS_ACKNOWLEDGEMENT_REQUIRED');
      expect([await versions(), await publishes()]).toEqual([v, p]);
      await alice
        .post(`/store/templates/${indexId}/publish`, {
          acknowledgedWarnings: warnings,
        })
        .expect(200);
      expect(await versions()).toBe(v + 1);
      expect(await publishes()).toBe(p + 1);
    });

    it('a clean document publishes with no acknowledgements and still records the publish', async () => {
      await setDraft(
        indexId,
        withSection('clean', richText({ heading: 'Hello' })),
      );
      const p = await publishes();
      await alice.post(`/store/templates/${indexId}/publish`, {}).expect(200);
      expect(await publishes()).toBe(p + 1);
    });

    it('design:publish is still required: write and read members get 403 before any check', async () => {
      await setDraft(
        indexId,
        withSection('clean2', richText({ heading: 'Hi' })),
      );
      const [v, p] = [await versions(), await publishes()];
      for (const level of ['none', 'read', 'write']) {
        await members[level].post('/store/theme/publish', {}).expect(403);
        await members[level]
          .post(`/store/templates/${indexId}/publish`, {})
          .expect(403);
      }
      expect([await versions(), await publishes()]).toEqual([v, p]);
      await members.publish.post('/store/theme/publish', {}).expect(200);
      expect(await publishes()).toBe(p + 1);
    });

    it('is tenant isolated: store B (Studio off) is unaffected by A, and A acknowledgements do not leak', async () => {
      const bobTemplates = (await bob.get('/store/templates').expect(200)).body
        .data as { id: string; kind: string; isDefault: boolean }[];
      const bobIndex = bobTemplates.find(
        (x) => x.kind === 'index' && x.isDefault,
      )!.id;
      const doc = (await bob.get(`/store/templates/${bobIndex}`).expect(200))
        .body.data.document as Doc;
      await t.db.asOwner((pg) =>
        pg.query('update templates set draft = $1::jsonb where id = $2', [
          JSON.stringify({
            ...doc,
            sections: {
              ...doc.sections,
              bad: {
                type: 'rich-text',
                settings: {},
                blocks: {
                  img: {
                    type: 'image',
                    settings: { image: { path: `${w.tenantB}/store/y.jpg` } },
                    blocks: {},
                    block_order: [],
                  },
                },
                block_order: ['img'],
              },
            },
            order: [...doc.order, 'bad'],
          }),
          bobIndex,
        ]),
      );
      const pA = await publishes(w.tenantA);
      await bob.post('/store/theme/publish', {}).expect(200);
      expect(await publishes(w.tenantB)).toBe(0);
      expect(await publishes(w.tenantA)).toBe(pA);
      // The report for B reflects B only, and is not enforced.
      expect((await report(bob)).enforced).toBe(false);
    });

    it('turning Studio off restores the old behaviour without deleting the history', async () => {
      const p = await publishes(w.tenantA);
      await setRollout(w.tenantA, false);
      await setDraft(
        indexId,
        withSection('late', richText({}, { img: imageBlock() })),
      );
      await alice.post('/store/theme/publish', {}).expect(200);
      expect(await publishes(w.tenantA)).toBe(p);
    });
  });
});
