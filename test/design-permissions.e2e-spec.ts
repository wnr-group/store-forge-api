import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  can,
  ROLE_PRESETS,
  type Actor,
} from '../src/common/constants/permissions.js';
import { rowsOf } from '../src/database/database.service.js';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  asUser,
  createTestDb,
  createUser,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Level = 'none' | 'read' | 'write' | 'publish';
const LEVELS: Level[] = ['none', 'read', 'write', 'publish'];
const RANK: Record<Level, number> = { none: 0, read: 1, write: 2, publish: 3 };

/** Products read so the member can see the products presentations are attached to; design is what varies. */
const perms = (design: Level) => ({
  products: 'read',
  orders: 'none',
  customers: 'none',
  settings: 'read',
  design,
});

const ok = (s: number) => (s >= 200 && s < 300) || s === 409; // 409 = authorized, business conflict
const denied = (s: number) => s === 403;

describe.skipIf(!migrationsAvailable)('design permissions (e2e)', () => {
  let t: TestApp;
  let w: World;
  let owner: Client;
  const ids = {} as Record<string, string>;
  const clients = {} as Record<string, Client>;
  const products = {} as Record<string, string>;
  let tplId = '';
  let liveVersionId = '';
  let oldVersionId = '';

  const addMember = async (
    name: string,
    permissions: object,
    capabilities: string[] = [],
  ) => {
    const id = await createUser(t.db, `${name}@design.test`, name);
    await t.db.asOwner((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, capabilities, status) values ($1,$2,'admin',$3::jsonb,$4::text[],'active')",
        [w.tenantA, id, JSON.stringify(permissions), capabilities],
      ),
    );
    ids[name] = id;
    clients[name] = await as(t, id, w.tenantA);
    return id;
  };

  /** Runs raw SQL as the member (role authenticated, RLS on). Returns affected rows, or the database error. */
  const run = async (userId: string, query: ReturnType<typeof sql>) => {
    try {
      const rows = await asUser(t.db, userId, async (tx) =>
        rowsOf(await tx.execute(query)),
      );
      return { rows: rows.length, error: '' };
    } catch (e) {
      let m = '';
      for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause)
        m += `${(x as Error).message} `;
      return { rows: 0, error: m };
    }
  };

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
    t = await createTestApp(db);
    owner = await as(t, w.alice);
    for (const l of LEVELS) await addMember(`lvl-${l}`, perms(l));
    // Capabilities are independent of the level.
    await addMember('attest-only', perms('none'), ['attest']);
    await addMember('discard-only', perms('none'), ['discard']);
    await addMember('publisher-no-caps', perms('publish'));
    await addMember('both-read', perms('read'), ['attest', 'discard']);

    await owner.post('/store/theme', { themeSlug: 'atelier' }).expect(200);
    const list = (await owner.get('/store/templates').expect(200)).body
      .data as { id: string; kind: string; isDefault: boolean }[];
    tplId = list.find((x) => x.kind === 'index' && x.isDefault)!.id;
    const d = (await owner.get(`/store/templates/${tplId}`).expect(200)).body
      .data;
    await owner
      .put(`/store/templates/${tplId}/draft`, {
        document: d.document,
        expectedRevision: d.revision,
      })
      .expect(200);
    await owner
      .post(`/store/templates/${tplId}/publish`, {
        expectedRevision: d.revision,
      })
      .expect(200);
    liveVersionId = (
      (await owner.get(`/store/templates/${tplId}/versions`).expect(200)).body
        .data as { id: string }[]
    )[0].id;
    // A second, older version the members try to point the template at (privileged setup, like a past publish).
    oldVersionId = await t.db.asOwner(async (pg) => {
      const r = await pg.query<{ id: string }>(
        `insert into template_versions (tenant_id, store_id, template_id, document, source)
         select tenant_id, store_id, id, draft, 'publish' from templates where id = $1 returning id`,
        [tplId],
      );
      return r.rows[0].id;
    });
    // One product (with a draft + live presentation row each) per scenario so scenarios never interfere.
    for (const key of ['api', ...LEVELS.map((l) => `db-${l}`)]) {
      const p = (
        await owner
          .post('/products', { name: `Design ${key}`, price: '2' })
          .expect(201)
      ).body.data.id as string;
      products[key] = p;
      await owner
        .put(`/store/product-presentations/${p}/draft`, {
          document: { schemaVersion: 1 },
          expectedRevision: 0,
        })
        .expect(200);
    }
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const presentation = (productKey: string) => products[productKey];

  describe('API: what each level may do', () => {
    for (const level of LEVELS) {
      it(`design ${level}`, async () => {
        const c = clients[`lvl-${level}`];
        const r = RANK[level];
        const detail = (
          await owner.get(`/store/templates/${tplId}`).expect(200)
        ).body.data as { document: unknown; revision: number };
        const pid = presentation('api');
        const results: Record<string, number> = {
          'list templates': (await c.get('/store/templates')).status,
          'get template': (await c.get(`/store/templates/${tplId}`)).status,
          'template versions': (
            await c.get(`/store/templates/${tplId}/versions`)
          ).status,
          'theme catalogue': (await c.get('/themes')).status,
          'current theme': (await c.get('/store/theme')).status,
          'list presentations': (await c.get('/store/product-presentations'))
            .status,
          'get presentation': (
            await c.get(`/store/product-presentations/${pid}`)
          ).status,
          'save draft': (
            await c.put(`/store/templates/${tplId}/draft`, {
              document: detail.document,
              expectedRevision: detail.revision,
            })
          ).status,
          'apply theme': (
            await c.post('/store/theme', { themeSlug: 'atelier' })
          ).status,
          'save presentation draft': (
            await c.put(`/store/product-presentations/${pid}/draft`, {
              document: { schemaVersion: 1 },
              expectedRevision: 0,
            })
          ).status,
          publish: (await c.post(`/store/templates/${tplId}/publish`, {}))
            .status,
          rollback: (
            await c.post(`/store/templates/${tplId}/rollback`, {
              versionId: oldVersionId,
            })
          ).status,
          'publish theme': (await c.post('/store/theme/publish', {})).status,
          'publish presentation': (
            await c.post(`/store/product-presentations/${pid}/publish`, {})
          ).status,
        };
        const need: Record<string, number> = {
          'list templates': 1,
          'get template': 1,
          'template versions': 1,
          'theme catalogue': 1,
          'current theme': 1,
          'list presentations': 1,
          'get presentation': 1,
          'save draft': 2,
          'apply theme': 2,
          'save presentation draft': 2,
          publish: 3,
          rollback: 3,
          'publish theme': 3,
          'publish presentation': 3,
        };
        for (const [op, s] of Object.entries(results)) {
          if (r >= need[op]) expect(ok(s), `${op} -> ${s}`).toBe(true);
          else expect(denied(s), `${op} -> ${s}`).toBe(true);
        }
        // Reset (delete the product's settings) is draft-level work: design write.
        const reset = (await c.delete(`/store/product-presentations/${pid}`))
          .status;
        if (r >= 2) expect(ok(reset)).toBe(true);
        else expect(denied(reset)).toBe(true);
        // Put the row back for the next level.
        await owner
          .put(`/store/product-presentations/${pid}/draft`, {
            document: { schemaVersion: 1 },
            expectedRevision: 0,
          })
          .catch(() => undefined);
      });
    }

    it('editing never publishes: a write-level save leaves the live version untouched', async () => {
      const before = (
        await owner.get(`/store/templates/${tplId}/versions`).expect(200)
      ).body.data as { id: string; isLive: boolean }[];
      const live = before.find((v) => v.isLive)!.id;
      const d = (await owner.get(`/store/templates/${tplId}`).expect(200)).body
        .data;
      await clients['lvl-write']
        .put(`/store/templates/${tplId}/draft`, {
          document: d.document,
          expectedRevision: d.revision,
        })
        .expect(200);
      const after = (
        await owner.get(`/store/templates/${tplId}/versions`).expect(200)
      ).body.data as { id: string; isLive: boolean }[];
      expect(after.find((v) => v.isLive)!.id).toBe(live);
    });
  });

  describe('database: what each level may do as role authenticated', () => {
    for (const level of LEVELS) {
      it(`design ${level}`, async () => {
        const id = ids[`lvl-${level}`];
        const r = RANK[level];
        const pid = presentation(`db-${level}`);

        // Draft write on the template: RLS hides the row from an UPDATE without design:write.
        const draft = await run(
          id,
          sql`update public.templates set draft = draft where id = ${tplId}::uuid returning id`,
        );
        expect(draft.error).toBe('');
        expect(draft.rows).toBe(r >= 2 ? 1 : 0);

        // Insert of a template draft row.
        const insert = await run(
          id,
          sql`insert into public.templates (tenant_id, store_id, kind, name, draft)
              select tenant_id, store_id, 'collection', ${`Tpl ${level}`}, draft from public.templates where id = ${tplId}::uuid`,
        );
        if (r >= 2) expect(insert.error).toBe('');
        else expect(insert.error).toMatch(/row-level security/);

        // Product presentation draft update / delete, now gated by the module (it only had role policies).
        const pdraft = await run(
          id,
          sql`update public.product_presentations set draft = draft where product_id = ${pid}::uuid returning product_id`,
        );
        expect(pdraft.error).toBe('');
        expect(pdraft.rows).toBe(r >= 2 ? 1 : 0);

        // Publishing a presentation (changing `published`) needs design:publish.
        const ppub = await run(
          id,
          sql`update public.product_presentations set published = draft where product_id = ${pid}::uuid returning product_id`,
        );
        if (r >= 3) {
          expect(ppub.error).toBe('');
          expect(ppub.rows).toBe(1);
        } else if (r === 2) {
          expect(ppub.error).toMatch(/design:publish/);
        } else {
          expect(ppub.error).toBe('');
          expect(ppub.rows).toBe(0);
        }

        // Publishing a template version: insert into the immutable history needs design:publish.
        const version = await run(
          id,
          sql`insert into public.template_versions (tenant_id, store_id, template_id, document, source)
              select tenant_id, store_id, id, draft, 'publish' from public.templates where id = ${tplId}::uuid`,
        );
        if (r >= 3) expect(version.error).toBe('');
        else expect(version.error).toMatch(/row-level security/);

        // Moving the published pointer needs design:publish, even for a member who may write the draft.
        const pointer = await run(
          id,
          sql`update public.templates set published_version_id = ${oldVersionId}::uuid where id = ${tplId}::uuid returning id`,
        );
        if (r >= 3) {
          expect(pointer.error).toBe('');
          expect(pointer.rows).toBe(1);
          // Restore the pointer for the following assertions.
          await t.db.asOwner((pg) =>
            pg.query(
              'update templates set published_version_id = $1 where id = $2',
              [liveVersionId, tplId],
            ),
          );
        } else if (r === 2) {
          expect(pointer.error).toMatch(/design:publish/);
        } else {
          expect(pointer.error).toBe('');
          expect(pointer.rows).toBe(0);
        }

        // Apply-theme rows (store_themes) are draft-level.
        const theme = await run(
          id,
          sql`update public.store_themes set theme_version = theme_version where store_id = ${w.storeA}::uuid returning store_id`,
        );
        expect(theme.error).toBe('');
        expect(theme.rows).toBe(r >= 2 ? 1 : 0);

        // Delete of a presentation: design write.
        const del = await run(
          id,
          sql`delete from public.product_presentations where product_id = ${pid}::uuid returning product_id`,
        );
        expect(del.error).toBe('');
        expect(del.rows).toBe(r >= 2 ? 1 : 0);

        // Reading stays open to members at the database level (the API narrows it with design:view).
        const read = await run(
          id,
          sql`select id from public.templates where id = ${tplId}::uuid`,
        );
        expect(read.rows).toBe(1);
      });
    }

    it('the Owner keeps full publish power at the database level', async () => {
      const r = await run(
        w.alice,
        sql`update public.templates set published_version_id = ${oldVersionId}::uuid where id = ${tplId}::uuid returning id`,
      );
      expect(r.error).toBe('');
      expect(r.rows).toBe(1);
      await t.db.asOwner((pg) =>
        pg.query(
          'update templates set published_version_id = $1 where id = $2',
          [liveVersionId, tplId],
        ),
      );
    });

    it("another organization's owner cannot publish this store's template", async () => {
      const r = await run(
        w.bob,
        sql`update public.templates set published_version_id = ${oldVersionId}::uuid where id = ${tplId}::uuid returning id`,
      );
      expect(r.rows).toBe(0);
    });

    it('the existing settings:write gate no longer opens the design tables', async () => {
      // A member with settings write but design none (a post-migration member) cannot write the draft.
      const id = await addMember('settings-only', {
        products: 'read',
        orders: 'none',
        customers: 'none',
        settings: 'write',
      });
      const r = await run(
        id,
        sql`update public.templates set draft = draft where id = ${tplId}::uuid returning id`,
      );
      expect(r.rows).toBe(0);
      await clients['settings-only'].get('/store/templates').expect(403);
    });

    it('the validation function accepts publish on design only', async () => {
      const bad = (permissions: object) =>
        t.db.asOwner(async (pg) => {
          const r = await pg.query<{ ok: boolean }>(
            'select public.is_valid_member_permissions($1::jsonb) as ok',
            [JSON.stringify(permissions)],
          );
          return r.rows[0].ok;
        });
      expect(await bad({ design: 'publish' })).toBe(true);
      expect(await bad({ products: 'publish' })).toBe(false);
      expect(await bad({ settings: 'publish' })).toBe(false);
      expect(await bad({ design: 'admin' })).toBe(false);
      expect(await bad({ products: 'write', design: 'none' })).toBe(true);
      expect(await bad({ nope: 'read' })).toBe(false);
    });
  });

  describe('capabilities attest and discard are independent of the level', () => {
    const cap = async (userId: string, c: 'attest' | 'discard') => {
      const rows = await asUser(t.db, userId, async (tx) =>
        rowsOf<{ v: boolean }>(
          await tx.execute(
            sql`select public.has_member_capability(${w.tenantA}::uuid, ${c}) as v`,
          ),
        ),
      );
      return rows[0].v;
    };

    it('database function: granted per member, never implied by a level, always on for the Owner', async () => {
      expect(await cap(ids['attest-only'], 'attest')).toBe(true);
      expect(await cap(ids['attest-only'], 'discard')).toBe(false);
      expect(await cap(ids['discard-only'], 'discard')).toBe(true);
      expect(await cap(ids['discard-only'], 'attest')).toBe(false);
      expect(await cap(ids['publisher-no-caps'], 'attest')).toBe(false);
      expect(await cap(ids['publisher-no-caps'], 'discard')).toBe(false);
      expect(await cap(ids['both-read'], 'attest')).toBe(true);
      expect(await cap(ids['both-read'], 'discard')).toBe(true);
      expect(await cap(w.alice, 'attest')).toBe(true);
      expect(await cap(w.alice, 'discard')).toBe(true);
    });

    it('API: a capability grants no design access and a design level grants no capability', async () => {
      await clients['attest-only'].get('/store/templates').expect(403);
      await clients['discard-only'].get('/store/templates').expect(403);
      await clients['attest-only']
        .put(`/store/templates/${tplId}/draft`, {
          document: {},
          expectedRevision: 1,
        })
        .expect(403);
      const pub = clients['publisher-no-caps'];
      await pub.get('/store/templates').expect(200);
      const me = (await pub.get('/organizations/current').expect(200)).body
        .data;
      expect(me.capabilities).toEqual([]);
      expect(
        (await clients['attest-only'].get('/organizations/current').expect(200))
          .body.data.capabilities,
      ).toEqual(['attest']);
      expect(
        (await clients['both-read'].get('/organizations/current').expect(200))
          .body.data.capabilities,
      ).toEqual(['attest', 'discard']);
      expect(
        (await owner.get('/organizations/current').expect(200)).body.data
          .capabilities,
      ).toEqual(['attest', 'discard']);
    });

    it('can(): design:attest / design:discard depend only on the capability', () => {
      const m = (
        design: Level,
        capabilities: Actor['capabilities'],
      ): Actor => ({
        role: 'admin',
        permissions: { design },
        capabilities,
      });
      for (const level of LEVELS) {
        expect(can(m(level, []), 'design:attest')).toBe(false);
        expect(can(m(level, []), 'design:discard')).toBe(false);
        expect(can(m(level, ['attest']), 'design:attest')).toBe(true);
        expect(can(m(level, ['attest']), 'design:discard')).toBe(false);
        expect(can(m(level, ['discard']), 'design:discard')).toBe(true);
      }
      // ...and a level never depends on a capability.
      expect(can(m('publish', []), 'design:publish')).toBe(true);
      expect(can(m('none', ['attest', 'discard']), 'design:view')).toBe(false);
      const ownerActor: Actor = { role: 'owner', permissions: {} };
      for (const p of [
        'design:view',
        'design:edit',
        'design:publish',
        'design:attest',
        'design:discard',
      ] as const)
        expect(can(ownerActor, p)).toBe(true);
    });

    it('can(): publish implies write implies read; none grants nothing', () => {
      const at = (design: Level): Actor => ({
        role: 'admin',
        permissions: { design },
      });
      for (const level of LEVELS) {
        expect(can(at(level), 'design:view')).toBe(RANK[level] >= 1);
        expect(can(at(level), 'design:edit')).toBe(RANK[level] >= 2);
        expect(can(at(level), 'design:publish')).toBe(RANK[level] >= 3);
      }
      // publish is a design-only level: it does not raise another module.
      expect(
        can(
          { role: 'admin', permissions: { products: 'publish' } },
          'catalog:manage',
        ),
      ).toBe(true); // treated as write, never more
      expect(
        can(
          { role: 'admin', permissions: { products: 'publish' } },
          'design:view',
        ),
      ).toBe(false);
    });

    it('the capabilities column only accepts attest and discard', async () => {
      const bad = await run(
        w.alice,
        sql`update public.memberships set capabilities = array['publish'] where user_id = ${ids['lvl-read']}::uuid`,
      );
      expect(bad.error).not.toBe('');
      await expect(
        t.db.asOwner((pg) =>
          pg.query(
            "update memberships set capabilities = array['bogus'] where user_id = $1",
            [ids['lvl-read']],
          ),
        ),
      ).rejects.toThrow(/memberships_capabilities_check/);
    });
  });

  describe('team routes: the Owner sets design level and capabilities', () => {
    const FULL = {
      products: 'write',
      orders: 'read',
      customers: 'write',
      settings: 'write',
    };
    let memberId = '';
    const row = async (userId: string) =>
      (await owner.get('/team/members').expect(200)).body.data.find(
        (m: { userId: string }) => m.userId === userId,
      ) as {
        permissions: Record<string, string>;
        capabilities: string[];
        roleLabel: string;
      };

    it('creates a member with a design level and capabilities', async () => {
      const res = await owner
        .post('/team/members', {
          fullName: 'Design Hire',
          email: 'design.hire@example.test',
          password: 'Passw0rd-1',
          permissions: { ...FULL, design: 'write' },
          capabilities: ['discard'],
        })
        .expect(201);
      memberId = res.body.data.userId;
      const m = await row(memberId);
      expect(m.permissions.design).toBe('write');
      expect(m.capabilities).toEqual(['discard']);
      const hire = await as(t, memberId, w.tenantA);
      await hire.get('/store/templates').expect(200);
      await hire.post(`/store/templates/${tplId}/publish`, {}).expect(403);
    });

    it('a new member without a design level gets none', async () => {
      const res = await owner
        .post('/team/members', {
          fullName: 'No Design',
          email: 'no.design@example.test',
          password: 'Passw0rd-1',
          permissions: FULL,
        })
        .expect(201);
      const m = await row(res.body.data.userId);
      expect(m.permissions.design).toBeUndefined();
      expect(m.capabilities).toEqual([]);
      const c = await as(t, res.body.data.userId, w.tenantA);
      await c.get('/store/templates').expect(403);
    });

    it('edits the design level and capabilities, each independently', async () => {
      await owner
        .patch(`/team/members/${memberId}`, {
          permissions: { ...FULL, design: 'publish' },
        })
        .expect(200);
      let m = await row(memberId);
      expect(m.permissions.design).toBe('publish');
      expect(m.capabilities).toEqual(['discard']); // untouched
      await owner
        .patch(`/team/members/${memberId}`, {
          capabilities: ['attest', 'discard'],
        })
        .expect(200);
      m = await row(memberId);
      expect(m.capabilities).toEqual(['attest', 'discard']);
      expect(m.permissions.design).toBe('publish'); // untouched
      await owner
        .patch(`/team/members/${memberId}`, { capabilities: [] })
        .expect(200);
      expect((await row(memberId)).capabilities).toEqual([]);
    });

    it('a client that omits design on an edit does not wipe the level', async () => {
      await owner
        .patch(`/team/members/${memberId}`, {
          permissions: { ...FULL, products: 'read' },
        })
        .expect(200);
      const m = await row(memberId);
      expect(m.permissions.design).toBe('publish');
      expect(m.permissions.products).toBe('read');
    });

    it('rejects unknown levels and capabilities', async () => {
      await owner
        .patch(`/team/members/${memberId}`, {
          permissions: { ...FULL, design: 'admin' },
        })
        .expect(400);
      await owner
        .patch(`/team/members/${memberId}`, { capabilities: ['publish'] })
        .expect(400);
      await owner
        .patch(`/team/members/${memberId}`, {
          capabilities: ['attest', 'attest'],
        })
        .expect(400);
      await owner
        .patch(`/team/members/${memberId}`, {
          permissions: { ...FULL, products: 'publish' },
        })
        .expect(400);
    });

    it('only the Owner can change them: a design publisher cannot', async () => {
      const pub = clients['publisher-no-caps'];
      await pub
        .patch(`/team/members/${memberId}`, { capabilities: ['attest'] })
        .expect(403);
      await pub
        .patch(`/team/members/${ids['lvl-read']}`, {
          permissions: { ...FULL, design: 'publish' },
        })
        .expect(403);
    });
  });

  describe('migrate_design_permissions(): conversion of existing members', () => {
    type Mig = {
      user_id: string;
      before_permissions: Record<string, string>;
      after_permissions: Record<string, string>;
      before_capabilities: string[];
      after_capabilities: string[];
      changed: boolean;
      role: string;
    };
    const legacy: Record<string, { p: object; id?: string }> = {
      manager: {
        p: {
          products: 'write',
          orders: 'write',
          customers: 'write',
          settings: 'write',
        },
      },
      managerOrdersRead: {
        p: {
          products: 'write',
          orders: 'read',
          customers: 'write',
          settings: 'write',
        },
      },
      staff: {
        p: {
          products: 'write',
          orders: 'read',
          customers: 'write',
          settings: 'read',
        },
      },
      viewer: {
        p: {
          products: 'read',
          orders: 'read',
          customers: 'read',
          settings: 'read',
        },
      },
      settingsWriteOnly: {
        p: {
          products: 'none',
          orders: 'none',
          customers: 'none',
          settings: 'write',
        },
      },
      almostManager: {
        p: {
          products: 'write',
          orders: 'read',
          customers: 'read',
          settings: 'write',
        },
      },
      noSettings: { p: { products: 'read' } },
      empty: { p: {} },
      alreadyConverted: {
        p: {
          products: 'write',
          orders: 'read',
          customers: 'write',
          settings: 'write',
          design: 'read',
        },
      },
    };
    const call = () =>
      t.db.asOwner(async (pg) => {
        const r = await pg.query<Mig>(
          'select * from public.migrate_design_permissions()',
        );
        return r.rows;
      });
    const snapshot = () =>
      t.db.asOwner(async (pg) => {
        const r = await pg.query(
          'select id, role, permissions, capabilities from memberships order by id',
        );
        return r.rows;
      });
    const logCount = () =>
      t.db.asOwner(async (pg) => {
        const r = await pg.query<{ n: string }>(
          'select count(*)::text n from design_permission_migration_log',
        );
        return Number(r.rows[0].n);
      });
    let first: Mig[] = [];
    let logAfterFirst = 0;
    let afterFirst: unknown[] = [];

    beforeAll(async () => {
      for (const [name, l] of Object.entries(legacy)) {
        l.id = await createUser(t.db, `legacy-${name}@design.test`, name);
        await t.db.asOwner((pg) =>
          pg.query(
            "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin',$3::jsonb,'active')",
            [w.tenantA, l.id, JSON.stringify(l.p)],
          ),
        );
      }
      first = await call();
      logAfterFirst = await logCount();
      afterFirst = await snapshot();
    });

    const of = (name: string) =>
      first.find((r) => r.user_id === legacy[name].id)!;

    it('settings write -> design publish; settings read -> read; none -> none', () => {
      expect(of('manager').after_permissions.design).toBe('publish');
      expect(of('settingsWriteOnly').after_permissions.design).toBe('publish');
      expect(of('staff').after_permissions.design).toBe('read');
      expect(of('viewer').after_permissions.design).toBe('read');
      expect(of('noSettings').after_permissions.design).toBe('none');
      expect(of('empty').after_permissions.design).toBe('none');
      // the four existing modules are never touched
      for (const name of Object.keys(legacy)) {
        const { design: _d, ...rest } = of(name).after_permissions;
        const { design: _b, ...before } = of(name).before_permissions;
        void _d;
        void _b;
        expect(rest).toEqual(before);
      }
    });

    it('attest is added only to members whose permissions equal the Manager preset; discard never', () => {
      expect(of('manager').after_capabilities).toEqual(['attest']);
      expect(of('managerOrdersRead').after_capabilities).toEqual(['attest']);
      for (const n of [
        'staff',
        'viewer',
        'settingsWriteOnly',
        'almostManager',
        'noSettings',
        'empty',
        'alreadyConverted',
      ])
        expect(of(n).after_capabilities, n).toEqual([]);
      for (const n of Object.keys(legacy))
        expect(of(n).after_capabilities, n).not.toContain('discard');
      // the Manager preset of the code is the shape the SQL recognises
      expect(ROLE_PRESETS.manager.capabilities).toEqual(['attest']);
    });

    it('a member who already has a design level is left exactly as is', () => {
      expect(of('alreadyConverted').changed).toBe(false);
      expect(of('alreadyConverted').after_permissions.design).toBe('read');
    });

    it('owners are implicit: reported unchanged, no stored level', () => {
      const owners = first.filter((r) => r.role === 'owner');
      expect(owners.length).toBeGreaterThanOrEqual(2);
      for (const o of owners) {
        expect(o.changed).toBe(false);
        expect(o.after_permissions.design).toBeUndefined();
      }
    });

    it('returns and records a before/after comparison per changed member', async () => {
      const legacyIds = Object.values(legacy).map((l) => l.id);
      const changed = first.filter(
        (r) => r.changed && legacyIds.includes(r.user_id),
      );
      expect(changed.map((r) => r.user_id).sort()).toEqual(
        [
          'manager',
          'managerOrdersRead',
          'staff',
          'viewer',
          'settingsWriteOnly',
          'almostManager',
          'noSettings',
          'empty',
        ]
          .map((n) => legacy[n].id!)
          .sort(),
      );
      for (const r of changed) {
        expect(r.before_permissions.design).toBeUndefined();
        expect(r.after_permissions.design).toBeDefined();
      }
      expect(logAfterFirst).toBeGreaterThanOrEqual(changed.length);
      const logged = await t.db.asOwner(async (pg) => {
        const r = await pg.query<{
          before_permissions: Record<string, string>;
          after_permissions: Record<string, string>;
          after_capabilities: string[];
        }>('select * from design_permission_migration_log where user_id = $1', [
          legacy.manager.id,
        ]);
        return r.rows;
      });
      expect(logged).toHaveLength(1);
      expect(logged[0].before_permissions.design).toBeUndefined();
      expect(logged[0].after_permissions.design).toBe('publish');
      expect(logged[0].after_capabilities).toEqual(['attest']);
    });

    it('is idempotent: a second run changes nothing and logs nothing', async () => {
      const second = await call();
      expect(second.every((r) => r.changed === false)).toBe(true);
      expect(second).toHaveLength(first.length);
      expect(await logCount()).toBe(logAfterFirst);
      expect(await snapshot()).toEqual(afterFirst);
      // and a third time for good measure, after an Owner edit that must survive
      await t.db.asOwner((pg) =>
        pg.query(
          `update memberships set permissions = permissions || '{"design":"none"}'::jsonb, capabilities = '{}' where user_id = $1`,
          [legacy.manager.id],
        ),
      );
      const third = await call();
      expect(third.every((r) => r.changed === false)).toBe(true);
      const m = await t.db.asOwner(async (pg) => {
        const r = await pg.query<{
          permissions: Record<string, string>;
          capabilities: string[];
        }>(
          'select permissions, capabilities from memberships where user_id = $1',
          [legacy.manager.id],
        );
        return r.rows[0];
      });
      expect(m.permissions.design).toBe('none');
      expect(m.capabilities).toEqual([]);
    });

    it('no Owner and no Manager loses publish; a Staff-preset member gains nothing', async () => {
      // Owner: publish through the implicit rule at the database level.
      const ownerPub = await run(
        w.alice,
        sql`select 1 where public.has_module_access(${w.tenantA}::uuid, 'design', 'publish')`,
      );
      expect(ownerPub.rows).toBe(1);
      // Every converted member who could write settings can publish; nobody else can.
      for (const name of [
        'manager',
        'managerOrdersRead',
        'settingsWriteOnly',
        'almostManager',
      ]) {
        if (name === 'manager') continue; // changed by the Owner-edit step above
        const r = await run(
          legacy[name].id!,
          sql`select 1 where public.has_module_access(${w.tenantA}::uuid, 'design', 'publish')`,
        );
        expect(r.rows, name).toBe(1);
      }
      for (const name of ['staff', 'viewer']) {
        const publish = await run(
          legacy[name].id!,
          sql`select 1 where public.has_module_access(${w.tenantA}::uuid, 'design', 'publish')`,
        );
        const write = await run(
          legacy[name].id!,
          sql`select 1 where public.has_module_access(${w.tenantA}::uuid, 'design', 'write')`,
        );
        const read = await run(
          legacy[name].id!,
          sql`select 1 where public.has_module_access(${w.tenantA}::uuid, 'design', 'read')`,
        );
        expect(publish.rows, `${name} publish`).toBe(0);
        expect(write.rows, `${name} write`).toBe(0);
        expect(read.rows, `${name} read (kept)`).toBe(1);
        const c = await as(t, legacy[name].id!, w.tenantA);
        await c.post(`/store/templates/${tplId}/publish`, {}).expect(403);
        const d = (await owner.get(`/store/templates/${tplId}`).expect(200))
          .body.data;
        await c
          .put(`/store/templates/${tplId}/draft`, {
            document: d.document,
            expectedRevision: d.revision,
          })
          .expect(403);
        await c.get('/store/templates').expect(200);
      }
      // Whole table: settings write <=> design publish for every non-owner converted row.
      const bad = await t.db.asOwner(async (pg) => {
        const r = await pg.query(
          `select user_id from memberships
           where role <> 'owner' and user_id = any($1::uuid[])
             and (permissions ->> 'settings' = 'write') and (permissions ->> 'design') is distinct from 'publish'
             and user_id <> $2`,
          [
            Object.values(legacy)
              .map((l) => l.id)
              .filter((x) => x !== legacy.alreadyConverted.id),
            legacy.manager.id,
          ],
        );
        return r.rows;
      });
      expect(bad).toEqual([]);
    });

    it('the application roles can neither call the function nor read its log', async () => {
      const call2 = await run(
        w.alice,
        sql`select * from public.migrate_design_permissions()`,
      );
      expect(call2.error).toMatch(/permission denied/);
      const log = await run(
        w.alice,
        sql`select * from public.design_permission_migration_log`,
      );
      expect(log.error).toMatch(/permission denied/);
    });

    it('the log is append-only', async () => {
      await expect(
        t.db.asOwner((pg) =>
          pg.query('delete from design_permission_migration_log'),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        t.db.asOwner((pg) =>
          pg.query('update design_permission_migration_log set run_at = now()'),
        ),
      ).rejects.toThrow(/append-only/);
    });
  });
});
