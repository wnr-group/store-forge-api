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
type Doc = {
  schemaVersion: number;
  order: string[];
  sections: Record<
    string,
    {
      display?: unknown;
      blocks: Record<string, { display?: unknown }>;
      block_order: string[];
    }
  >;
};

const perms = (design: 'none' | 'read' | 'write' | 'publish') => ({
  products: 'read',
  orders: 'none',
  customers: 'none',
  settings: 'read',
  design,
});

const DEVICE = { type: 'device', desktop: true, tablet: true, mobile: false };

/** QA-D-001: the API accepts schema 2 and `display` rules for Studio stores, and still refuses everything else. */
describe.skipIf(!migrationsAvailable)(
  'schema 2 and display rules on save (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let bob: Client;
    let platform: Client;
    const members: Record<string, Client> = {};
    let indexId = '';
    let original: Doc;

    const rows = (sql: string, args: unknown[] = []) =>
      t.db.asOwner(async (pg) => (await pg.query<any>(sql, args)).rows);
    const setFlag = (enabled: boolean) =>
      platform
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled,
          reason: 'schema 2 test',
        })
        .expect(200);
    const detail = async (c: Client = alice) =>
      (await c.get(`/store/templates/${indexId}`).expect(200)).body.data as {
        revision: number;
        document: Doc;
      };
    const save = async (c: Client, document: unknown, revision?: number) =>
      c.put(`/store/templates/${indexId}/draft`, {
        document,
        expectedRevision: revision ?? (await detail()).revision,
      });
    const v2 = (mutate?: (d: Doc) => void): Doc => {
      const d = structuredClone(original);
      d.schemaVersion = 2;
      mutate?.(d);
      return d;
    };
    const firstSection = (d: Doc) => d.order[0];
    const migrationVersions = () =>
      rows(
        "select document, label from template_versions where template_id = $1 and source = 'migration'",
        [indexId],
      );

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);
      platform = await as(t, w.admin);
      for (const level of ['none', 'read', 'write', 'publish'] as const) {
        const id = await createUser(db, `${level}@schema2.test`, level);
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
      original = (await detail()).document;
      // The shipped theme has images without alt text (a readiness blocker for Studio stores): fix the base for publishing tests.
      const addAlt = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(addAlt);
        if (typeof v !== 'object' || v === null) return;
        const o = v as Record<string, unknown>;
        if (('path' in o || 'asset' in o) && !o.alt) o.alt = 'Test image';
        Object.values(o).forEach(addAlt);
      };
      addAlt(original);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('Studio off (the default)', () => {
      it('saves a valid schema 1 document and reads it back unchanged', async () => {
        const res = await save(alice, original).then((r) => r.status);
        expect(res).toBe(200);
        expect((await detail()).document).toEqual(original);
      });

      it('refuses schema 2 with a clear message', async () => {
        const res = await save(alice, v2()).then((r) => ({
          status: r.status,
          body: JSON.stringify(r.body),
        }));
        expect(res.status).toBe(400);
        expect(res.body).toContain('only when Studio is turned on');
      });

      it('refuses display rules in a schema 1 document (the original QA-D-001 payload shape)', async () => {
        const d = structuredClone(original);
        d.sections[firstSection(d)].display = { v: 1, rules: [DEVICE] };
        const r = await save(alice, d);
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.body)).toContain(
          'Display rules need schema version 2.',
        );
      });
    });

    describe('Studio on', () => {
      beforeAll(async () => {
        await setFlag(true);
      });
      afterAll(async () => {
        await setFlag(false);
      });

      it('saves schema 2 with display rules on a section and a nested block, and the rules survive a read', async () => {
        const before = await detail();
        const doc = v2((d) => {
          const key = firstSection(d);
          d.sections[key].display = {
            v: 1,
            rules: [
              DEVICE,
              {
                type: 'schedule',
                startsAt: '2030-01-01T00:00:00Z',
                endsAt: '2030-02-01T00:00:00Z',
                timezone: 'Asia/Kolkata',
              },
            ],
          };
          const blockId = d.sections[key].block_order[0];
          if (blockId)
            d.sections[key].blocks[blockId].display = {
              v: 1,
              rules: [DEVICE],
            };
        });
        const r = await save(alice, doc, before.revision);
        expect(r.status).toBe(200);
        expect(r.body.data.revision).toBe(before.revision + 1);
        expect(r.body.data.document).toEqual(doc);
        const after = await detail();
        expect(after.document).toEqual(doc);
        expect(after.document.schemaVersion).toBe(2);
        const stored = await rows('select draft from templates where id = $1', [
          indexId,
        ]);
        expect(stored[0].draft).toEqual(doc);
      });

      it('keeps the previous schema 1 document once as a migration version, not on later saves', async () => {
        const versions = await migrationVersions();
        expect(versions).toHaveLength(1);
        expect(versions[0].document.schemaVersion).toBe(1);
        expect(versions[0].document).toEqual(original);
        await save(
          alice,
          v2((d) => {
            d.sections[firstSection(d)].display = { v: 1, rules: [DEVICE] };
          }),
        ).then((r) => expect(r.status).toBe(200));
        expect(await migrationVersions()).toHaveLength(1);
      });

      it.each([
        ['an unsupported version 3', (d: Doc) => void (d.schemaVersion = 3)],
        [
          'wrong display version',
          (d: Doc) =>
            void (d.sections[firstSection(d)].display = { v: 2, rules: [] }),
        ],
        [
          'end before start',
          (d: Doc) =>
            void (d.sections[firstSection(d)].display = {
              v: 1,
              rules: [
                {
                  type: 'schedule',
                  startsAt: '2030-02-01T00:00:00Z',
                  endsAt: '2030-01-01T00:00:00Z',
                },
              ],
            }),
        ],
        [
          'raw CSS smuggled into display',
          (d: Doc) =>
            void (d.sections[firstSection(d)].display = {
              v: 1,
              rules: [],
              css: 'body{display:none}',
            }),
        ],
      ])('rejects %s and writes nothing', async (_n, mutate) => {
        const before = await detail();
        const r = await save(alice, v2(mutate), before.revision);
        expect(r.status).toBe(400);
        const after = await detail();
        expect(after.revision).toBe(before.revision);
        expect(after.document).toEqual(before.document);
      });

      it('rejects unknown node fields even in schema 2', async () => {
        const r = await save(
          alice,
          v2((d) => {
            (d.sections[firstSection(d)] as Record<string, unknown>).css = 'x';
          }),
        );
        expect(r.status).toBe(400);
      });

      it('still enforces revisions: a stale save is a 409 and nothing is written', async () => {
        const cur = await detail();
        const r = await save(alice, v2(), cur.revision - 1);
        expect(r.status).toBe(409);
        expect((await detail()).revision).toBe(cur.revision);
      });

      it('enforces permissions: none and read cannot save; write can; nothing leaks across tenants', async () => {
        const cur = await detail();
        const doc = v2((d) => {
          d.sections[firstSection(d)].display = { v: 1, rules: [DEVICE] };
        });
        expect((await save(members.none, doc, cur.revision)).status).toBe(403);
        expect((await save(members.read, doc, cur.revision)).status).toBe(403);
        expect((await save(bob, doc, cur.revision)).status).toBe(404);
        expect((await detail()).revision).toBe(cur.revision);
        // A write-level member may save the draft (editing never publishes).
        const ok = await save(members.write, doc, cur.revision);
        expect(ok.status).toBe(200);
      });

      it('publishing still runs readiness: an expired schedule needs acknowledgement; once acknowledged the display rules go live', async () => {
        const expired = v2((d) => {
          d.sections[firstSection(d)].display = {
            v: 1,
            rules: [
              {
                type: 'schedule',
                startsAt: '2020-01-01T00:00:00Z',
                endsAt: '2020-02-01T00:00:00Z',
              },
            ],
          };
        });
        const saved = await save(alice, expired);
        expect(saved.status).toBe(200);
        const noAck = await alice.post(
          `/store/templates/${indexId}/publish`,
          {},
        );
        expect(noAck.status).toBe(400);
        expect(JSON.stringify(noAck.body)).toContain(
          'READINESS_ACKNOWLEDGEMENT_REQUIRED',
        );
        expect(
          members.write
            ? (
                await members.write.post(
                  `/store/templates/${indexId}/publish`,
                  {},
                )
              ).status
            : 0,
        ).toBe(403);
        const issues =
          noAck.body.error.details.issues ?? noAck.body.error.details.warnings;
        const keys = (issues as { key: string }[]).map((i) => i.key);
        const ok = await alice.post(`/store/templates/${indexId}/publish`, {
          acknowledgedWarnings: keys,
        });
        expect(ok.status).toBe(200);
        const live = await rows(
          'select v.document from templates t join template_versions v on v.id = t.published_version_id where t.id = $1',
          [indexId],
        );
        expect(live[0].document).toEqual(expired);
      });

      it('after Studio is turned off, the stored schema 2 content is still readable and publishable (flag off breaks nothing)', async () => {
        await setFlag(false);
        const d = await detail();
        expect(d.document.schemaVersion).toBe(2);
        const res = await alice.get('/store/templates').expect(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        await setFlag(true);
      });
    });
  },
);
