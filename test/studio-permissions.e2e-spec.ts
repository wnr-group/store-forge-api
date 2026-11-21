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
type Level = 'none' | 'read' | 'write';
const perms = (products: Level, settings: Level) => ({
  products,
  orders: 'none',
  customers: 'none',
  settings,
});

describe.skipIf(!migrationsAvailable)('Studio permission matrix (e2e)', () => {
  let t: TestApp;
  let w: World;
  let owner: Client;
  let designOnly: Client;
  let catalogOnly: Client;
  let readAll: Client;
  let noProducts: Client;
  let tplId = '';
  let versionId = '';

  const member = async (name: string, p: ReturnType<typeof perms>) => {
    const id = await createUser(t.db, `${name}@perm.test`, name);
    await t.db.asOwner((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin',$3::jsonb,'active')",
        [w.tenantA, id, JSON.stringify(p)],
      ),
    );
    return as(t, id);
  };

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) => syncThemeCatalogue(drizzle(pg) as never));
    t = await createTestApp(db);
    owner = await as(t, w.alice);
    designOnly = await member('design-only', perms('none', 'write'));
    catalogOnly = await member('catalog-only', perms('write', 'none'));
    readAll = await member('read-all', perms('read', 'read'));
    noProducts = await member('no-products', perms('none', 'read'));
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
      .post(`/store/templates/${tplId}/publish`, { expectedRevision: d.revision })
      .expect(200);
    versionId = (
      (await owner.get(`/store/templates/${tplId}/versions`).expect(200)).body
        .data as { id: string }[]
    )[0].id;
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  const detail = async () =>
    (await owner.get(`/store/templates/${tplId}`).expect(200)).body.data as {
      document: unknown;
      revision: number;
    };
  type Op = readonly [string, () => Promise<{ status: number }>];
  const design = (c: Client): Op[] => [
    [
      'save draft',
      async () => {
        const d = await detail();
        return c.put(`/store/templates/${tplId}/draft`, {
          document: d.document,
          expectedRevision: d.revision,
        });
      },
    ],
    ['publish', async () => c.post(`/store/templates/${tplId}/publish`, {})],
    [
      'rollback',
      async () => c.post(`/store/templates/${tplId}/rollback`, { versionId }),
    ],
    ['apply theme', async () => c.post('/store/theme', { themeSlug: 'atelier' })],
    [
      'product presentation draft',
      async () => {
        const id = (
          await owner
            .post('/products', { name: `PP ${Math.random()}`, price: '2' })
            .expect(201)
        ).body.data.id as string;
        return c.put(`/store/product-presentations/${id}/draft`, {
          document: { schemaVersion: 1 },
          expectedRevision: 0,
        });
      },
    ],
  ];
  const catalog = (c: Client): Op[] => [
    [
      'create product',
      async () => c.post('/products', { name: `P ${Math.random()}`, price: '1' }),
    ],
    [
      'create category',
      async () => c.post('/categories', { name: `C ${Math.random()}` }),
    ],
    [
      'create collection',
      async () => c.post('/collections', { name: `K ${Math.random()}` }),
    ],
    [
      'import products',
      async () =>
        c.post('/products/import', {
          rows: [{ row: 2, name: `Imp ${Math.random()}`, price: '1' }],
        }),
    ],
  ];
  const statuses = async (ops: Op[]) =>
    Object.fromEntries(
      await Promise.all(ops.map(async ([n, f]) => [n, (await f()).status] as const)),
    );
  /** Authorized: success, or a business conflict (409, e.g. rolling back to the live version) - never 401/403/5xx. */
  const allowed = (s: Record<string, number>) =>
    Object.values(s).every((x) => (x >= 200 && x < 300) || x === 409);
  const denied = (s: Record<string, number>) =>
    Object.values(s).every((x) => x === 403);

  it('the owner can do everything', async () => {
    expect(allowed(await statuses(design(owner)))).toBe(true);
    expect(allowed(await statuses(catalog(owner)))).toBe(true);
  });
  it('settings write (design only) can design but cannot touch the catalogue', async () => {
    // Finding F-PERM-1: a member with design write but no products access cannot see products (RLS), so saving a
    // per-product presentation answers 404 for them. Every other design operation is authorized.
    const s = await statuses(design(designOnly));
    expect(s['product presentation draft']).toBe(404);
    delete s['product presentation draft'];
    expect(allowed(s)).toBe(true);
    expect(denied(await statuses(catalog(designOnly)))).toBe(true);
  });
  it('products write (catalogue only) can manage and import but cannot design', async () => {
    expect(allowed(await statuses(catalog(catalogOnly)))).toBe(true);
    expect(denied(await statuses(design(catalogOnly)))).toBe(true);
  });
  it('read-only members and members without products access are rejected on every write', async () => {
    for (const c of [readAll, noProducts]) {
      expect(denied(await statuses(design(c)))).toBe(true);
      expect(denied(await statuses(catalog(c)))).toBe(true);
    }
  });
  it('viewing: every member can read templates and versions; catalogue reads need products access', async () => {
    for (const c of [designOnly, catalogOnly, readAll, noProducts]) {
      await c.get('/store/templates').expect(200);
      await c.get(`/store/templates/${tplId}/versions`).expect(200);
    }
    await readAll.get('/products').expect(200);
    await noProducts.get('/products').expect(403);
    await designOnly.get('/products').expect(403);
  });
  it('collection delete needs the products module like other catalogue writes', async () => {
    const c = (await owner.post('/collections', { name: 'Del perm' }).expect(201))
      .body.data.id;
    await designOnly.delete(`/collections/${c}`).expect(403);
    await readAll.delete(`/collections/${c}`).expect(403);
    await catalogOnly.delete(`/collections/${c}`).expect(200);
  });
  it("is tenant-scoped: another organization's owner cannot use this store's template ids", async () => {
    const bob = await as(t, w.bob);
    await bob
      .put(`/store/templates/${tplId}/draft`, {
        document: { schemaVersion: 1, layout: 'classic', sections: {}, order: [] },
        expectedRevision: 1,
      })
      .expect(404);
    await bob.post(`/store/templates/${tplId}/publish`, {}).expect(404);
  });
});
