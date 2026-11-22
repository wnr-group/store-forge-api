import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import {
  createTestDb,
  MIGRATIONS_DIR,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

// Real generator by default; a test can queue specific values to force collisions.
vi.mock('../src/common/utils/public-id.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../src/common/utils/public-id.js')>();
  return { ...actual, generatePublicId: vi.fn(actual.generatePublicId) };
});
import { generatePublicId } from '../src/common/utils/public-id.js';

const PUBLIC_ID = /^[a-z0-9]{5,8}$/;

const org = (n: number, extra: Record<string, unknown> = {}) => ({
  companyName: `Company ${n}`,
  storeName: `Store ${n}`,
  storeSlug: `store-${n}`,
  ownerName: `Owner ${n}`,
  ownerEmail: `owner${n}@example.test`,
  ownerPassword: 'Passw0rd-1',
  ...extra,
});

describe.skipIf(!migrationsAvailable)('tenant public id (e2e)', () => {
  let t: TestApp;
  let w: World;
  let admin: Awaited<ReturnType<typeof as>>;
  let sup: Awaited<ReturnType<typeof as>>; // own rate-limit bucket (10 creations per admin per 10 minutes)

  const publicIdOf = (tenantId: string) =>
    t.db.asOwner(async (pg) => {
      const r = await pg.query<{ public_id: string }>(
        'select public_id from tenants where id = $1',
        [tenantId],
      );
      return r.rows[0].public_id;
    });

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    admin = await as(t, w.admin);
    sup = await as(t, w.superAdmin);
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  it('gives every seeded tenant a valid, unique public id', async () => {
    const rows = await t.db.asOwner(
      async (pg) =>
        (await pg.query<{ public_id: string }>('select public_id from tenants'))
          .rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.public_id).toMatch(PUBLIC_ID);
    expect(new Set(rows.map((r) => r.public_id)).size).toBe(rows.length);
  });

  it('generates a unique id for each new organization', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const res = await admin
        .post('/platform/organizations', org(n))
        .expect(201);
      ids.push(await publicIdOf(res.body.data.tenantId));
    }
    for (const id of ids) expect(id).toMatch(PUBLIC_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a caller-supplied publicId on create and update', async () => {
    await admin
      .post('/platform/organizations', org(20, { publicId: 'hack1' }))
      .expect(400);
    const created = await admin
      .post('/platform/organizations', org(21))
      .expect(201);
    const id = created.body.data.tenantId;
    const before = await publicIdOf(id);
    await admin
      .patch(`/platform/organizations/${id}`, {
        companyName: 'Renamed',
        publicId: 'hack2',
      })
      .expect(400);
    expect(await publicIdOf(id)).toBe(before);
  });

  it('never changes the public id when the tenant is edited', async () => {
    const created = await admin
      .post('/platform/organizations', org(22))
      .expect(201);
    const id = created.body.data.tenantId;
    const before = await publicIdOf(id);
    await admin
      .patch(`/platform/organizations/${id}`, {
        companyName: 'Another Name',
        contactPhone: '+44 20 7946 0958',
        address: 'New address 5',
      })
      .expect(200);
    expect(await publicIdOf(id)).toBe(before);
  });

  it('retries with a fresh id when the generated one is already taken', async () => {
    const first = await admin
      .post('/platform/organizations', org(30))
      .expect(201);
    const taken = await publicIdOf(first.body.data.tenantId);

    const gen = vi.mocked(generatePublicId);
    gen.mockReturnValueOnce(taken).mockReturnValueOnce(taken);
    const second = await admin
      .post('/platform/organizations', org(31))
      .expect(201);
    const fresh = await publicIdOf(second.body.data.tenantId);
    expect(fresh).not.toBe(taken);
    expect(fresh).toMatch(PUBLIC_ID);
    // The collision left nothing half-created: exactly one tenant for this store address.
    const count = await t.db.asOwner(
      async (pg) =>
        (
          await pg.query<{ n: number }>(
            "select count(*)::int as n from tenants where name = 'Company 31'",
          )
        ).rows[0].n,
    );
    expect(count).toBe(1);
  });

  it('gives up with a server error after repeated collisions without creating a tenant', async () => {
    const existing = await t.db.asOwner(
      async (pg) =>
        (
          await pg.query<{ public_id: string }>(
            'select public_id from tenants limit 1',
          )
        ).rows[0].public_id,
    );
    vi.mocked(generatePublicId).mockReturnValue(existing);
    try {
      await sup.post('/platform/organizations', org(40)).expect(500);
    } finally {
      vi.mocked(generatePublicId).mockReset();
      const actual = await vi.importActual<
        typeof import('../src/common/utils/public-id.js')
      >('../src/common/utils/public-id.js');
      vi.mocked(generatePublicId).mockImplementation(actual.generatePublicId);
    }
    const n = await t.db.asOwner(
      async (pg) =>
        (
          await pg.query<{ n: number }>(
            "select count(*)::int as n from tenants where name = 'Company 40'",
          )
        ).rows[0].n,
    );
    expect(n).toBe(0);
  });

  describe('API responses', () => {
    it('returns publicId on create, in the list and in the detail, matching the database', async () => {
      const res = await sup
        .post('/platform/organizations', org(50))
        .expect(201);
      const { tenantId, publicId } = res.body.data;
      expect(publicId).toMatch(PUBLIC_ID);
      expect(publicId).toBe(await publicIdOf(tenantId));

      const detail = (
        await admin.get(`/platform/organizations/${tenantId}`).expect(200)
      ).body.data;
      expect(detail.company).toMatchObject({ id: tenantId, publicId });

      const list = (
        await admin.get('/platform/organizations?limit=100').expect(200)
      ).body.data as { id: string; publicId: string }[];
      expect(list.length).toBeGreaterThan(1);
      for (const row of list)
        expect(row.publicId).toBe(await publicIdOf(row.id));
    });

    it('keeps the same publicId in the update response', async () => {
      const { tenantId, publicId } = (
        await sup.post('/platform/organizations', org(51)).expect(201)
      ).body.data;
      const updated = await admin
        .patch(`/platform/organizations/${tenantId}`, {
          companyName: 'Fifty One',
        })
        .expect(200);
      expect(updated.body.data).toMatchObject({
        name: 'Fifty One',
        publicId,
      });
    });

    it("shows the public storefront its own organization's publicId, and nothing for an unknown store", async () => {
      const pubA = await publicIdOf(w.tenantA);
      const pubB = await publicIdOf(w.tenantB);
      const a = await anonymous(t)
        .get('/public/storefronts/alpha-shop')
        .expect(200);
      expect(a.body.data).toMatchObject({ slug: 'alpha-shop', publicId: pubA });
      const b = await anonymous(t)
        .get('/public/storefronts/beta-shop')
        .expect(200);
      expect(b.body.data).toMatchObject({ slug: 'beta-shop', publicId: pubB });
      expect(pubA).not.toBe(pubB);
      await anonymous(t).get('/public/storefronts/no-such-store').expect(404);
    });

    it('stores each store address as {store slug}-{tenant public id}, kept in step by the database', async () => {
      const pubA = await publicIdOf(w.tenantA);
      await t.db.asOwner(async (pg) => {
        const all = (
          await pg.query<{
            slug: string;
            subdomain: string;
            public_id: string;
          }>(
            'select s.slug, s.subdomain, t.public_id from stores s join tenants t on t.id = s.tenant_id',
          )
        ).rows;
        expect(all.length).toBeGreaterThan(0);
        for (const r of all)
          expect(r.subdomain).toBe(`${r.slug}-${r.public_id}`);

        // A hand-written value is overwritten; a slug rename moves the address; renaming back restores it.
        await pg.query(
          "update stores set subdomain = 'forged-aaaaaa' where slug = 'alpha-shop'",
        );
        const sub = () =>
          pg
            .query<{ subdomain: string }>(
              'select subdomain from stores where id = $1',
              [w.storeA],
            )
            .then((r) => r.rows[0].subdomain);
        expect(await sub()).toBe(`alpha-shop-${pubA}`);
        await pg.query(
          "update stores set slug = 'alpha-renamed' where id = $1",
          [w.storeA],
        );
        expect(await sub()).toBe(`alpha-renamed-${pubA}`);
        await pg.query("update stores set slug = 'alpha-shop' where id = $1", [
          w.storeA,
        ]);
        expect(await sub()).toBe(`alpha-shop-${pubA}`);

        // The tenant's public id can never change, not even for the table owner.
        await expect(
          pg.query("update tenants set public_id = 'zzzzzz' where id = $1", [
            w.tenantA,
          ]),
        ).rejects.toThrow(/public_id is immutable/);
      });
    });

    it('resolves a host label to its store through GET /public/hosts/:subdomain, and nothing else', async () => {
      const pubA = await publicIdOf(w.tenantA);
      const pubB = await publicIdOf(w.tenantB);
      const ok = await anonymous(t)
        .get(`/public/hosts/alpha-shop-${pubA}`)
        .expect(200);
      expect(ok.body.data).toEqual({ slug: 'alpha-shop', publicId: pubA });
      // Another tenant's id, a made-up id, the bare slug (older format) and junk all look the same: not found.
      for (const label of [
        `alpha-shop-${pubB}`,
        'alpha-shop-zzzzzz',
        'alpha-shop',
        'no-such-store-aaaaaa',
        '-bad-',
        'a.b',
      ])
        await anonymous(t)
          .get(`/public/hosts/${encodeURIComponent(label)}`)
          .expect(404);
    });

    it("gives members only their own organization's publicId", async () => {
      const alice = await as(t, w.alice);
      const current = (await alice.get('/organizations/current').expect(200))
        .body.data;
      expect(current.organization).toMatchObject({
        id: w.tenantA,
        slug: 'alpha-shop',
        publicId: await publicIdOf(w.tenantA),
      });
      const mine = (await alice.get('/organizations').expect(200)).body.data;
      expect(mine).toHaveLength(1);
      expect(mine[0].publicId).toBe(await publicIdOf(w.tenantA));
      expect(JSON.stringify(mine)).not.toContain(await publicIdOf(w.tenantB));

      // Another organization's data stays out of reach.
      await (
        await as(t, w.alice, w.tenantB)
      )
        .get('/organizations/current')
        .expect(403);
      await alice.get(`/platform/organizations/${w.tenantB}`).expect(403);
      await alice.get('/platform/organizations').expect(403);
    });
  });

  it('enforces uniqueness, format and NOT NULL in the database; a member cannot edit it', async () => {
    await t.db.asOwner(async (pg) => {
      const a = await pg.query<{ public_id: string }>(
        'select public_id from tenants limit 1',
      );
      await expect(
        pg.query(
          "insert into tenants (name, slug, public_id) values ('Dup', 'dup-co', $1)",
          [a.rows[0].public_id],
        ),
      ).rejects.toThrow(/tenants_public_id_key/);
      await expect(
        pg.query(
          "insert into tenants (name, slug, public_id) values ('Bad', 'bad-co', 'AB')",
        ),
      ).rejects.toThrow(/tenants_public_id_check/);
      await expect(
        pg.query("insert into tenants (name, slug) values ('Nul', 'nul-co')"),
      ).rejects.toThrow(/null value/);
    });
    // Column-level privilege: authenticated users hold UPDATE on (name, slug) only.
    const priv = await t.db.asOwner(
      async (pg) =>
        (
          await pg.query<{ ok: boolean }>(
            `select has_column_privilege('authenticated', 'public.tenants', 'public_id', 'UPDATE') as ok`,
          )
        ).rows[0].ok,
    );
    expect(priv).toBe(false);
  });
});

describe.skipIf(!migrationsAvailable)(
  'migration 0028 on a database with existing tenants',
  () => {
    let pg: PGlite;
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];

    beforeAll(async () => {
      // Apply everything BEFORE 0028 (later migrations read public_id, so they wait too) into a scratch folder, add data, then run 0028 on top.
      const dir = mkdtempSync(join(tmpdir(), 'sf-mig-'));
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const journalPath = join(dir, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
      journal.entries = journal.entries.filter(
        (e: { tag: string }) => e.tag < '0028',
      );
      writeFileSync(journalPath, JSON.stringify(journal));

      pg = new PGlite({ extensions: { pgcrypto } });
      await pg.exec(`
        create schema auth;
        create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb default '{}'::jsonb);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create role anon nologin; create role authenticated nologin; create role authenticator nologin;
        grant authenticated to authenticator; create role service_role nologin bypassrls;
        grant usage on schema public, auth to anon, authenticated, service_role;
        grant execute on function auth.uid() to anon, authenticated, service_role;`);
      await migrate(drizzle(pg), { migrationsFolder: dir });
      for (const [i, id] of ids.entries()) {
        await pg.query(
          'insert into tenants (id, name, slug) values ($1, $2, $3)',
          [id, `Old Tenant ${i}`, `old-tenant-${i}`],
        );
      }
    });

    afterAll(async () => {
      await pg?.close();
    });

    it('backfills every tenant, keeps ids and rows, and adds the constraints', async () => {
      const before = (
        await pg.query<{ id: string; name: string; slug: string }>(
          'select id, name, slug from tenants order by id',
        )
      ).rows;
      const sqlText = readFileSync(
        join(MIGRATIONS_DIR, '0028_tenant_public_id.sql'),
        'utf-8',
      );
      await pg.exec(sqlText.replaceAll('--> statement-breakpoint', ''));

      const after = (
        await pg.query<{
          id: string;
          name: string;
          slug: string;
          public_id: string;
        }>('select id, name, slug, public_id from tenants order by id')
      ).rows;
      expect(after.map(({ id, name, slug }) => ({ id, name, slug }))).toEqual(
        before,
      );
      for (const r of after) expect(r.public_id).toMatch(PUBLIC_ID);
      expect(new Set(after.map((r) => r.public_id)).size).toBe(ids.length);

      const col = (
        await pg.query<{ is_nullable: string }>(
          "select is_nullable from information_schema.columns where table_name = 'tenants' and column_name = 'public_id'",
        )
      ).rows[0];
      expect(col.is_nullable).toBe('NO');
    });
  },
);
