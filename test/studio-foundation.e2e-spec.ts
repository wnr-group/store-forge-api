import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import { featureAvailability } from '../src/modules/studio/feature-availability.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  asUser,
  createTestDb,
  createUser,
  migrationsAvailable,
  provision,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;

const perms = (design: 'none' | 'read' | 'write' | 'publish') => ({
  products: 'read',
  orders: 'none',
  customers: 'none',
  settings: 'read',
  design,
});

/**
 * Studio foundation (migration 0037): rollout flag, legal wordings and approvals, attestations, media assets and publish
 * history. Every approval / wording row used here is inserted by the test itself into the throw-away test database.
 */
describe.skipIf(!migrationsAvailable)('studio foundation (e2e)', () => {
  let t: TestApp;
  let w: World;
  let alice: Client; // owner of A
  let bob: Client; // owner of B
  let sup: Client; // platform super admin
  let adminC: Client; // platform admin
  const ids: Record<string, string> = {};
  const clients: Record<string, Client> = {};
  let wordingV1 = '';

  const addMember = async (
    name: string,
    permissions: object,
    capabilities: string[] = [],
  ) => {
    const id = await createUser(t.db, `${name}@studio.test`, name);
    await t.db.asOwner((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, capabilities, status) values ($1,$2,'admin',$3::jsonb,$4::text[],'active')",
        [w.tenantA, id, JSON.stringify(permissions), capabilities],
      ),
    );
    ids[name] = id;
    clients[name] = await as(t, id, w.tenantA);
  };

  /** Raw SQL as a signed-in user (role authenticated, RLS on). */
  const run = async (userId: string, query: ReturnType<typeof sql>) => {
    try {
      const rows = await asUser(t.db, userId, async (tx) =>
        rowsOf<Record<string, unknown>>(await tx.execute(query)),
      );
      return { rows, error: '' };
    } catch (e) {
      let m = '';
      for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause)
        m += `${(x as Error).message} `;
      return { rows: [] as Record<string, unknown>[], error: m };
    }
  };

  /** Privileged SQL (table owner / superuser): the strongest role there is. Returns the error text, or ''. */
  const asOwnerTry = async (query: string, params: unknown[] = []) => {
    try {
      await t.db.asOwner((pg) => pg.query(query, params));
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  const ownerCount = (table: string) =>
    t.db.asOwner(async (pg) =>
      Number(
        (await pg.query<{ n: string }>(`select count(*) n from ${table}`))
          .rows[0].n,
      ),
    );

  const createWording = async (
    key: string,
    text: string,
    status: 'draft' | 'approved' = 'approved',
  ) =>
    (
      await sup
        .post('/platform/legal/wordings', {
          key,
          languageTag: 'en-IN',
          text,
          status,
        })
        .expect(201)
    ).body.data as { id: string; version: number; status: string };

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    t = await createTestApp(db);
    alice = await as(t, w.alice);
    bob = await as(t, w.bob);
    sup = await as(t, w.superAdmin);
    adminC = await as(t, w.admin);
    await addMember('reader', perms('read'));
    await addMember('writer', perms('write'));
    await addMember('publisher', perms('publish'));
    await addMember('attester', perms('none'), ['attest']);
  });
  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  describe('nothing is seeded', () => {
    it('migrations create no wording and no approval; every feature starts unavailable', async () => {
      expect(await ownerCount('legal_wordings')).toBe(0);
      expect(await ownerCount('feature_approvals')).toBe(0);
      expect(await ownerCount('store_studio_rollout')).toBe(0);
      const s = (await alice.get('/store/studio/status').expect(200)).body.data;
      expect(s.features).toEqual({
        badge_upload: 'unavailable',
        review_import: 'unavailable',
      });
    });
  });

  describe('rollout flag', () => {
    it('is disabled by default for existing stores and for a store provisioned later', async () => {
      for (const c of [alice, bob]) {
        const s = (await c.get('/store/studio/status').expect(200)).body.data;
        expect(s).toMatchObject({
          enabled: false,
          schemaV2Capable: false,
          schemaVersion: 1,
          pointOfNoReturnAt: null,
        });
      }
      const dan = await createUser(t.db, 'dan@studio.test', 'Dan');
      await provision(t.db, w.superAdmin, dan, 'gamma-shop');
      const s = (
        await (await as(t, dan)).get('/store/studio/status').expect(200)
      ).body.data;
      expect(s.enabled).toBe(false);
    });

    it('status needs design:view; a member with design none is refused', async () => {
      await clients.reader.get('/store/studio/status').expect(200);
      await clients.attester.get('/store/studio/status').expect(403);
    });

    it('only a platform admin can change it: owners and members get 403, a reason is required', async () => {
      const body = { enabled: true, reason: 'pilot' };
      await alice
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, body)
        .expect(403);
      await clients.publisher
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, body)
        .expect(403);
      await sup
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled: true,
        })
        .expect(400);
      await sup
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled: true,
          reason: '   ',
        })
        .expect(400);
      await sup
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled: true,
          reason: 'x'.repeat(501),
        })
        .expect(400);
      expect((await alice.get('/store/studio/status')).body.data.enabled).toBe(
        false,
      );
    });

    it('enable and disable are audited and isolated per organization; disabling deletes nothing', async () => {
      const on = await adminC
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled: true,
          reason: 'Pilot customer, approved by support',
        })
        .expect(200);
      expect(on.body.data).toMatchObject({ storeId: w.storeA, enabled: true });
      expect((await alice.get('/store/studio/status')).body.data).toMatchObject(
        {
          enabled: true,
          schemaV2Capable: true,
          schemaVersion: 2,
        },
      );
      // Organization B is untouched.
      expect((await bob.get('/store/studio/status')).body.data.enabled).toBe(
        false,
      );

      await sup
        .put(`/platform/organizations/${w.tenantA}/studio-rollout`, {
          enabled: false,
          reason: 'Rolled back for the pilot review',
        })
        .expect(200);
      expect((await alice.get('/store/studio/status')).body.data.enabled).toBe(
        false,
      );
      // The store is still there and still readable.
      await alice.get('/store').expect(200);

      const events = (
        await adminC
          .get(`/platform/organizations/${w.tenantA}/studio-rollout/events`)
          .expect(200)
      ).body;
      expect(events.data.map((e: { action: string }) => e.action)).toEqual([
        'disabled',
        'enabled',
      ]);
      expect(events.data[1]).toMatchObject({
        reason: 'Pilot customer, approved by support',
        previous: { enabled: false },
        new: { enabled: true },
        actorId: w.admin,
      });
      // Organization B has no history.
      expect(
        (
          await adminC
            .get(`/platform/organizations/${w.tenantB}/studio-rollout/events`)
            .expect(200)
        ).body.data,
      ).toEqual([]);

      const audit = (
        await sup
          .get('/platform/audit-logs?action=store.studio_rollout_changed')
          .expect(200)
      ).body.data as { organizationId: string; newData: { reason: string } }[];
      expect(audit).toHaveLength(2);
      expect(audit.every((a) => a.organizationId === w.tenantA)).toBe(true);
      expect(audit.map((a) => a.newData.reason)).toContain(
        'Rolled back for the pilot review',
      );
    });

    it('history is platform-admin only and an unknown organization is a 404', async () => {
      await alice
        .get(`/platform/organizations/${w.tenantA}/studio-rollout/events`)
        .expect(403);
      await sup
        .get(
          '/platform/organizations/00000000-0000-4000-8000-0000000000aa/studio-rollout/events',
        )
        .expect(404);
      await sup
        .put(
          '/platform/organizations/00000000-0000-4000-8000-0000000000aa/studio-rollout',
          { enabled: true, reason: 'x' },
        )
        .expect(404);
    });

    it('the tables cannot be reached by the app role; the functions refuse non-admins and other tenants', async () => {
      for (const table of [
        'store_studio_rollout',
        'store_studio_rollout_events',
      ]) {
        expect(
          (await run(w.alice, sql.raw(`select * from ${table}`))).error,
        ).toMatch(/permission denied/);
        expect(
          (
            await run(
              w.alice,
              sql.raw(
                `update ${table} set tenant_id = tenant_id returning tenant_id`,
              ),
            )
          ).error,
        ).toMatch(/permission denied/);
      }
      expect(
        (
          await run(
            w.alice,
            sql`select public.platform_set_studio_rollout(${w.tenantA}::uuid, true, 'sneaky')`,
          )
        ).error,
      ).toMatch(/not_platform_admin/);
      expect(
        (
          await run(
            w.alice,
            sql`select * from public.platform_list_studio_rollout_events(${w.tenantA}::uuid)`,
          )
        ).error,
      ).toMatch(/not_platform_admin/);
      // A member of A cannot read B's state through the status function.
      expect(
        (
          await run(
            w.alice,
            sql`select public.studio_rollout_status(${w.tenantB}::uuid)`,
          )
        ).error,
      ).toMatch(/forbidden/);
    });
  });

  describe('legal wordings and approvals', () => {
    it('only a platform admin can add wording or record approvals', async () => {
      const body = {
        key: 'badge_upload.attestation',
        languageTag: 'en-IN',
        text: 'I own the rights.',
      };
      await alice.post('/platform/legal/wordings', body).expect(403);
      await clients.publisher
        .post('/platform/legal/wordings', body)
        .expect(403);
      await alice
        .post('/platform/legal/approvals', {
          featureKey: 'badge_upload',
          wordingKey: body.key,
          wordingVersion: 1,
          approverRef: 'x',
          approvedAt: new Date().toISOString(),
          release: 'r1',
        })
        .expect(403);
      expect(await ownerCount('legal_wordings')).toBe(0);
    });

    it('members read only APPROVED wording; the version is assigned by the server', async () => {
      const key = 'badge_upload.attestation';
      const draft = await createWording(key, 'Draft text', 'draft');
      expect(draft).toMatchObject({ version: 1, status: 'draft' });
      // Nothing approved yet.
      await alice.get(`/store/legal/wordings/${key}`).expect(404);
      const v2 = await createWording(key, 'I confirm I own the badge rights.');
      expect(v2.version).toBe(2);
      wordingV1 = v2.id;
      const got = (await alice.get(`/store/legal/wordings/${key}`).expect(200))
        .body.data;
      expect(got).toMatchObject({
        key,
        version: 2,
        status: 'approved',
        text: 'I confirm I own the badge rights.',
      });
      // Both tenants see the same platform-wide wording; a member with no design access does not.
      await bob.get(`/store/legal/wordings/${key}`).expect(200);
      await clients.attester.get(`/store/legal/wordings/${key}`).expect(403);
      await alice.get('/store/legal/wordings/Bad Key').expect(400);
      await alice.get('/store/legal/wordings/does.not.exist').expect(404);
    });

    it('approved wording is immutable at every role; a draft stays editable; retiring is the only change', async () => {
      const key = 'immutable.check';
      const approved = await createWording(key, 'Fixed text');
      const draft = await createWording(key, 'Editable', 'draft');
      expect(
        await asOwnerTry(
          `update legal_wordings set "text" = 'x' where id = $1`,
          [approved.id],
        ),
      ).toMatch(/legal_wording_immutable/);
      expect(
        await asOwnerTry(`delete from legal_wordings where id = $1`, [
          approved.id,
        ]),
      ).toMatch(/legal_wording_immutable/);
      expect(await asOwnerTry(`truncate legal_wordings cascade`)).toMatch(
        /immutable|truncate/,
      );
      expect(
        await asOwnerTry(
          `update legal_wordings set "text" = 'edited' where id = $1`,
          [draft.id],
        ),
      ).toBe('');
      expect(
        await asOwnerTry(
          `update legal_wordings set status = 'retired' where id = $1`,
          [approved.id],
        ),
      ).toBe('');
      // Retired is frozen.
      expect(
        await asOwnerTry(
          `update legal_wordings set status = 'approved' where id = $1`,
          [approved.id],
        ),
      ).toMatch(/legal_wording_immutable/);
      expect(await ownerCount('legal_wordings')).toBeGreaterThan(0);
    });

    it('an unapproved feature stays unavailable; approval needs approved wording; retiring the wording withdraws it', async () => {
      const key = 'feature.wording';
      const draft = await createWording(key, 'Not approved yet', 'draft');
      const body = (version: number) => ({
        featureKey: 'review_import',
        wordingKey: key,
        wordingVersion: version,
        approverRef: 'LEGAL-1',
        approvedAt: '2026-01-01T00:00:00Z',
        release: '2026.1',
      });
      await t.db.service.withUser(w.alice, async (tx) => {
        expect(await featureAvailability(tx, 'review_import')).toBe(
          'unavailable',
        );
      });
      // Draft wording cannot be approved.
      const rejected = await sup
        .post('/platform/legal/approvals', body(draft.version))
        .expect(400);
      expect(rejected.body.error.code).toBe('WORDING_NOT_APPROVED');
      expect(await ownerCount('feature_approvals')).toBe(0);
      // A future approval date is refused.
      const approved = await createWording(key, 'Approved text');
      await sup
        .post('/platform/legal/approvals', {
          ...body(approved.version),
          approvedAt: '2999-01-01T00:00:00Z',
        })
        .expect(400);

      const ok = await adminC
        .post('/platform/legal/approvals', body(approved.version))
        .expect(201);
      expect(ok.body.data).toMatchObject({
        featureKey: 'review_import',
        wordingVersion: approved.version,
        approverRef: 'LEGAL-1',
      });
      await t.db.service.withUser(w.alice, async (tx) => {
        expect(await featureAvailability(tx, 'review_import')).toBe(
          'available',
        );
        expect(await featureAvailability(tx, 'badge_upload')).toBe(
          'unavailable',
        );
        expect(await featureAvailability(tx, 'unknown_feature')).toBe(
          'unavailable',
        );
      });
      expect(
        (await bob.get('/store/studio/status').expect(200)).body.data.features,
      ).toMatchObject({
        review_import: 'available',
        badge_upload: 'unavailable',
      });

      // Withdrawing the wording withdraws the feature.
      await t.db.asOwner((pg) =>
        pg.query(`update legal_wordings set status = 'retired' where id = $1`, [
          approved.id,
        ]),
      );
      await t.db.service.withUser(w.alice, async (tx) => {
        expect(await featureAvailability(tx, 'review_import')).toBe(
          'unavailable',
        );
      });
    });

    it('feature approvals are append-only for every role and unreachable for the app role', async () => {
      const before = await ownerCount('feature_approvals');
      expect(before).toBeGreaterThan(0);
      expect(
        await asOwnerTry(`update feature_approvals set release = 'x'`),
      ).toMatch(/feature_approval_immutable/);
      expect(await asOwnerTry(`delete from feature_approvals`)).toMatch(
        /feature_approval_immutable/,
      );
      expect(await asOwnerTry(`truncate feature_approvals`)).toMatch(
        /immutable/,
      );
      // Inserting an approval for wording that is not approved is refused even for the owner.
      expect(
        await asOwnerTry(
          `insert into feature_approvals (feature_key, wording_key, wording_version, approver_ref, approved_at, release, recorded_by)
           select 'x_feature', key, version, 'r', now(), 'r', $1 from legal_wordings where status <> 'approved' limit 1`,
          [w.superAdmin],
        ),
      ).toMatch(/wording_not_approved/);
      expect(await ownerCount('feature_approvals')).toBe(before);
      for (const table of ['feature_approvals', 'legal_wordings']) {
        expect(
          (await run(w.alice, sql.raw(`select * from ${table}`))).error,
        ).toMatch(/permission denied/);
        expect(
          (await run(w.alice, sql.raw(`delete from ${table} returning 1`)))
            .error,
        ).toMatch(/permission denied/);
      }
      expect(
        (
          await run(
            w.alice,
            sql`select public.platform_record_feature_approval('a_b', 'k', 1, 'r', now(), 'r')`,
          )
        ).error,
      ).toMatch(/not_platform_admin/);
    });
  });

  describe('attestations', () => {
    const key = 'badge_upload.attestation';
    const attest = (c: Client, over: object = {}) =>
      c.post('/store/attestations', {
        type: 'badge_upload',
        wordingKey: key,
        wordingVersion: 2,
        ...over,
      });

    it('records the exact wording version for the owner and for a member with the attest capability', async () => {
      const a = (await attest(alice).expect(201)).body.data;
      expect(a).toMatchObject({
        type: 'badge_upload',
        wordingId: wordingV1,
        wordingKey: key,
        wordingVersion: 2,
        userId: w.alice,
      });
      const b = (await attest(clients.attester).expect(201)).body.data;
      expect(b.userId).toBe(ids.attester);
      const db = await run(
        w.alice,
        sql`select wording_id, user_id from public.attestations where id = ${a.id}::uuid`,
      );
      expect(db.rows[0]).toMatchObject({
        wording_id: wordingV1,
        user_id: w.alice,
      });
    });

    it('requires the attest capability: design levels (even publish) are not enough', async () => {
      await attest(clients.writer).expect(403);
      await attest(clients.publisher).expect(403);
      await attest(clients.reader).expect(403);
      // ...and the database says the same.
      expect(
        (
          await run(
            ids.publisher,
            sql`insert into public.attestations (tenant_id, store_id, user_id, type, wording_id)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${ids.publisher}::uuid, 'badge_upload', ${wordingV1}::uuid)`,
          )
        ).error,
      ).toMatch(/row-level security/);
    });

    it('rejects unknown, unapproved and retired wording', async () => {
      const unknownVersion = await attest(alice, { wordingVersion: 99 }).expect(
        400,
      );
      expect(unknownVersion.body.error.code).toBe('WORDING_NOT_APPROVED');
      await attest(alice, { wordingVersion: 1 }).expect(400); // version 1 is a draft
      await attest(alice, { wordingKey: 'nope.nope' }).expect(400);
      await attest(alice, { wordingVersion: 0 }).expect(400);
      // A wording retired after the fact cannot be attested any more.
      const k2 = 'retire.me';
      const w1 = await createWording(k2, 'Soon retired');
      await attest(alice, {
        wordingKey: k2,
        wordingVersion: w1.version,
      }).expect(201);
      await t.db.asOwner((pg) =>
        pg.query(`update legal_wordings set status = 'retired' where id = $1`, [
          w1.id,
        ]),
      );
      await attest(alice, {
        wordingKey: k2,
        wordingVersion: w1.version,
      }).expect(400);
      // ...and the database refuses it even for a direct insert.
      expect(
        await asOwnerTry(
          `insert into attestations (tenant_id, store_id, user_id, type, wording_id) values ($1,$2,$3,'badge_upload',$4)`,
          [w.tenantA, w.storeA, w.alice, w1.id],
        ),
      ).toMatch(/wording_not_approved/);
    });

    it('type rules: a badge attestation cannot carry an import and vice versa; the file must exist in the store', async () => {
      await attest(alice, { importId: crypto.randomUUID() }).expect(400);
      await attest(alice, {
        type: 'review_import',
        assetId: crypto.randomUUID(),
      }).expect(400);
      const unknownAsset = await attest(alice, {
        assetId: crypto.randomUUID(),
      }).expect(400);
      expect(unknownAsset.body.error.code).toBe('MEDIA_NOT_FOUND');
      await attest(alice, {
        type: 'review_import',
        importId: crypto.randomUUID(),
      }).expect(201);
      await attest(alice, { type: 'other' }).expect(400);
    });

    it('two-tenant isolation: rows, inserts, spoofed users and the append-only rule', async () => {
      const mine = (await attest(alice).expect(201)).body.data;
      const theirs = (await attest(bob).expect(201)).body.data;
      const seenByAlice = await run(
        w.alice,
        sql`select id, tenant_id from public.attestations`,
      );
      expect(seenByAlice.rows.map((r) => r.tenant_id)).not.toContain(w.tenantB);
      expect(seenByAlice.rows.map((r) => r.id)).toContain(mine.id);
      expect(seenByAlice.rows.map((r) => r.id)).not.toContain(theirs.id);
      const seenByBob = await run(
        w.bob,
        sql`select id from public.attestations`,
      );
      expect(seenByBob.rows.map((r) => r.id)).toEqual([theirs.id]);
      // Another tenant, another user, a client-chosen time: all refused.
      expect(
        (
          await run(
            w.alice,
            sql`insert into public.attestations (tenant_id, store_id, user_id, type, wording_id)
                values (${w.tenantB}::uuid, ${w.storeB}::uuid, ${w.alice}::uuid, 'badge_upload', ${wordingV1}::uuid)`,
          )
        ).error,
      ).toMatch(/row-level security/);
      expect(
        (
          await run(
            w.alice,
            sql`insert into public.attestations (tenant_id, store_id, user_id, type, wording_id)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.bob}::uuid, 'badge_upload', ${wordingV1}::uuid)`,
          )
        ).error,
      ).toMatch(/row-level security/);
      expect(
        (
          await run(
            w.alice,
            sql`insert into public.attestations (tenant_id, store_id, user_id, type, wording_id, accepted_at)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.alice}::uuid, 'badge_upload', ${wordingV1}::uuid, '2000-01-01')`,
          )
        ).error,
      ).toMatch(/permission denied/);
      // A store of another tenant breaks the composite foreign key.
      expect(
        await asOwnerTry(
          `insert into attestations (tenant_id, store_id, user_id, type, wording_id) values ($1,$2,$3,'badge_upload',$4)`,
          [w.tenantA, w.storeB, w.alice, wordingV1],
        ),
      ).toMatch(/foreign key|attestations_store_fk/);
      // Append-only, for the app role and for the table owner.
      expect(
        (
          await run(
            w.alice,
            sql`update public.attestations set context = '{}'::jsonb returning id`,
          )
        ).error,
      ).toMatch(/permission denied/);
      expect(
        (await run(w.alice, sql`delete from public.attestations returning id`))
          .error,
      ).toMatch(/permission denied/);
      const before = await ownerCount('attestations');
      expect(
        await asOwnerTry(`update attestations set context = '{"a":1}'::jsonb`),
      ).toMatch(/studio_history_immutable/);
      expect(await asOwnerTry(`delete from attestations`)).toMatch(
        /studio_history_immutable/,
      );
      expect(await asOwnerTry(`truncate attestations cascade`)).not.toBe('');
      expect(await ownerCount('attestations')).toBe(before);
    });
  });

  describe('media assets', () => {
    const request = (c: Client, over: object = {}) =>
      c.post('/store/media-assets/upload-requests', {
        kind: 'badge_image',
        mimeType: 'image/png',
        sizeBytes: 2048,
        width: 200,
        height: 200,
        altText: 'A badge',
        ...over,
      });
    let assetA = { id: '', path: '' };

    it('design:edit may request an upload; the path is server-chosen, tenant-prefixed and a direct child', async () => {
      const r = (await request(clients.writer).expect(201)).body.data;
      expect(r.path).toMatch(new RegExp(`^${w.tenantA}/[A-Za-z0-9-]+\\.png$`));
      expect(r.signedUrl).toBeTruthy();
      assetA = r;
      for (const [mime, ext] of [
        ['image/jpeg', 'jpg'],
        ['image/webp', 'webp'],
      ]) {
        const x = (await request(alice, { mimeType: mime }).expect(201)).body
          .data;
        expect(x.path.endsWith(`.${ext}`)).toBe(true);
      }
      await request(clients.reader).expect(403);
      await request(clients.attester).expect(403);
    });

    it('rejects SVG and other types, oversize files, absurd dimensions and any client-chosen path', async () => {
      for (const mimeType of [
        'image/svg+xml',
        'image/gif',
        'text/html',
        'application/pdf',
      ])
        await request(alice, { mimeType }).expect(400);
      await request(alice, { sizeBytes: 5 * 1024 * 1024 + 1 }).expect(400);
      await request(alice, { sizeBytes: 0 }).expect(400);
      await request(alice, { width: 9000 }).expect(400);
      await request(alice, { height: 0 }).expect(400);
      await request(alice, { kind: 'avatar' }).expect(400);
      // The request has no path field: a client-supplied location (traversal, other tenant) is rejected outright.
      await request(alice, { path: `${w.tenantB}/x.png` }).expect(400);
      await request(alice, {
        storagePath: `${w.tenantA}/../${w.tenantB}/x.png`,
      }).expect(400);
    });

    it('the database refuses svg, traversal, another tenant and nested paths even for a direct insert', async () => {
      const insert = (path: string, mime = 'image/png') =>
        run(
          w.alice,
          sql`insert into public.media_assets (tenant_id, store_id, owner_user_id, kind, storage_path, mime_type, size_bytes, width, height)
              values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.alice}::uuid, 'badge_image', ${path}, ${mime}, 10, 10, 10)`,
        );
      const bad: [string, string?][] = [
        [`${w.tenantA}/x.svg`, 'image/svg+xml'],
        [`${w.tenantA}/x.svg`],
        [`${w.tenantA}/../${w.tenantB}/x.png`],
        [`${w.tenantA}/..png`],
        [`${w.tenantB}/x.png`],
        [`${w.tenantA}/store/x.png`],
        [`/${w.tenantA}/x.png`],
        [`${w.tenantA}/x.jpg`],
      ];
      for (const [p, m] of bad)
        expect((await insert(p, m)).error, `${p} ${m ?? ''}`).toMatch(
          /media_assets_(path|mime_type)_check|violates check/,
        );
      expect(
        (await insert(`${w.tenantA}/fine-${crypto.randomUUID()}.png`)).error,
      ).toBe('');
    });

    it('finalize verifies the object in Storage, then is idempotent', async () => {
      const f1 = await alice.post(
        `/store/media-assets/${assetA.id}/finalize`,
        {},
      );
      expect(f1.status).toBe(400); // not uploaded yet
      t.storage.upload(assetA.path, 'image/png', 1999);
      const f2 = (
        await clients.writer
          .post(`/store/media-assets/${assetA.id}/finalize`, {})
          .expect(200)
      ).body.data;
      expect(f2).toMatchObject({
        id: assetA.id,
        mimeType: 'image/png',
        sizeBytes: 1999,
        attestationId: null,
        storagePath: assetA.path,
      });
      expect(f2.finalizedAt).toBeTruthy();
      await alice
        .post(`/store/media-assets/${assetA.id}/finalize`, {})
        .expect(200);
      await clients.reader
        .post(`/store/media-assets/${assetA.id}/finalize`, {})
        .expect(403);
    });

    it('a file whose real type differs from the announced one is refused and removed', async () => {
      const r = (await request(alice).expect(201)).body.data;
      t.storage.upload(r.path, 'image/webp', 100);
      const res = await alice
        .post(`/store/media-assets/${r.id}/finalize`, {})
        .expect(400);
      expect(res.body.error.code).toBe('MEDIA_TYPE_MISMATCH');
      expect(t.storage.removed).toContain(r.path);
    });

    it('links the attestation made for exactly this file, once', async () => {
      const r = (await request(alice).expect(201)).body.data;
      t.storage.upload(r.path, 'image/png', 500);
      const att = (
        await alice
          .post('/store/attestations', {
            type: 'badge_upload',
            wordingKey: 'badge_upload.attestation',
            wordingVersion: 2,
            assetId: r.id,
          })
          .expect(201)
      ).body.data;
      const other = (
        await alice
          .post('/store/attestations', {
            type: 'badge_upload',
            wordingKey: 'badge_upload.attestation',
            wordingVersion: 2,
          })
          .expect(201)
      ).body.data;
      const wrong = await alice
        .post(`/store/media-assets/${r.id}/finalize`, {
          attestationId: other.id,
        })
        .expect(400);
      expect(wrong.body.error.code).toBe('ATTESTATION_MISMATCH');
      const done = (
        await alice
          .post(`/store/media-assets/${r.id}/finalize`, {
            attestationId: att.id,
          })
          .expect(200)
      ).body.data;
      expect(done.attestationId).toBe(att.id);
      await alice
        .post(`/store/media-assets/${r.id}/finalize`, {
          attestationId: other.id,
        })
        .expect(409);
    });

    it('two-tenant isolation: another tenant cannot finalize, see or write media; the writer level is enforced in the database', async () => {
      await bob
        .post(`/store/media-assets/${assetA.id}/finalize`, {})
        .expect(404);
      const seenByBob = await run(
        w.bob,
        sql`select id from public.media_assets`,
      );
      expect(seenByBob.rows.map((r) => r.id)).not.toContain(assetA.id);
      const seenByAlice = await run(
        w.alice,
        sql`select id, tenant_id from public.media_assets`,
      );
      expect(seenByAlice.rows.length).toBeGreaterThan(0);
      expect(seenByAlice.rows.every((r) => r.tenant_id === w.tenantA)).toBe(
        true,
      );
      // Bob inserting into tenant A's folder / tenant.
      expect(
        (
          await run(
            w.bob,
            sql`insert into public.media_assets (tenant_id, store_id, owner_user_id, kind, storage_path, mime_type, size_bytes, width, height)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.bob}::uuid, 'badge_image', ${`${w.tenantA}/z-${crypto.randomUUID()}.png`}, 'image/png', 10, 10, 10)`,
          )
        ).error,
      ).toMatch(/row-level security/);
      // A reader cannot write; a writer can delete their own tenant's row; bob's delete touches nothing.
      expect(
        (
          await run(
            ids.reader,
            sql`insert into public.media_assets (tenant_id, store_id, owner_user_id, kind, storage_path, mime_type, size_bytes, width, height)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${ids.reader}::uuid, 'badge_image', ${`${w.tenantA}/r-${crypto.randomUUID()}.png`}, 'image/png', 10, 10, 10)`,
          )
        ).error,
      ).toMatch(/row-level security/);
      expect(
        (
          await run(
            w.bob,
            sql`delete from public.media_assets where id = ${assetA.id}::uuid returning id`,
          )
        ).rows,
      ).toEqual([]);
      // The path and the owner can never change after creation (no UPDATE grant).
      expect(
        (
          await run(
            w.alice,
            sql`update public.media_assets set storage_path = storage_path returning id`,
          )
        ).error,
      ).toMatch(/permission denied/);
    });
  });

  describe('studio publish history', () => {
    const insert = (userId: string, tenant: string, store: string) =>
      run(
        userId,
        sql`insert into public.studio_publishes (tenant_id, store_id, published_by, items, studio_schema_version)
            values (${tenant}::uuid, ${store}::uuid, ${userId}::uuid, '[{"kind":"template"}]'::jsonb, 2) returning id, published_at`,
      );

    it('needs design:publish to insert and design:read to read; tenants are isolated', async () => {
      expect((await insert(ids.writer, w.tenantA, w.storeA)).error).toMatch(
        /row-level security/,
      );
      expect((await insert(ids.reader, w.tenantA, w.storeA)).error).toMatch(
        /row-level security/,
      );
      const ok = await insert(ids.publisher, w.tenantA, w.storeA);
      expect(ok.error).toBe('');
      const id = ok.rows[0].id as string;
      await insert(w.alice, w.tenantA, w.storeA);
      await insert(w.bob, w.tenantB, w.storeB);
      expect((await insert(w.alice, w.tenantB, w.storeB)).error).toMatch(
        /row-level security/,
      );
      // published_by must be the signed-in user.
      expect(
        (
          await run(
            ids.publisher,
            sql`insert into public.studio_publishes (tenant_id, store_id, published_by, studio_schema_version)
                values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.alice}::uuid, 2)`,
          )
        ).error,
      ).toMatch(/row-level security/);
      const seenByBob = await run(
        w.bob,
        sql`select id, tenant_id from public.studio_publishes`,
      );
      expect(seenByBob.rows.every((r) => r.tenant_id === w.tenantB)).toBe(true);
      expect(seenByBob.rows.map((r) => r.id)).not.toContain(id);
      expect(
        (
          await run(ids.reader, sql`select id from public.studio_publishes`)
        ).rows.map((r) => r.id),
      ).toContain(id);
      expect(
        (await run(ids.attester, sql`select id from public.studio_publishes`))
          .rows,
      ).toEqual([]);
    });

    it('the publish time is the database clock', async () => {
      const r = await run(
        w.alice,
        sql`insert into public.studio_publishes (tenant_id, store_id, published_by, studio_schema_version)
            values (${w.tenantA}::uuid, ${w.storeA}::uuid, ${w.alice}::uuid, 1) returning published_at`,
      );
      expect(r.error).toBe('');
      expect(
        Math.abs(
          Date.now() - new Date(r.rows[0].published_at as string).getTime(),
        ),
      ).toBeLessThan(60_000);
    });

    it('is append-only for the app role and the table owner', async () => {
      expect(
        (
          await run(
            w.alice,
            sql`update public.studio_publishes set fingerprint = 'x' returning id`,
          )
        ).error,
      ).toMatch(/permission denied/);
      expect(
        (
          await run(
            w.alice,
            sql`delete from public.studio_publishes returning id`,
          )
        ).error,
      ).toMatch(/permission denied/);
      const before = await ownerCount('studio_publishes');
      expect(
        await asOwnerTry(`update studio_publishes set fingerprint = 'x'`),
      ).toMatch(/studio_history_immutable/);
      expect(await asOwnerTry(`delete from studio_publishes`)).toMatch(
        /studio_history_immutable/,
      );
      expect(await asOwnerTry(`truncate studio_publishes`)).toMatch(
        /studio_history_immutable/,
      );
      expect(await ownerCount('studio_publishes')).toBe(before);
    });
  });

  describe('append-only history and organization deletion', () => {
    it('rollout events cannot be updated, deleted or truncated by any role', async () => {
      const before = await ownerCount('store_studio_rollout_events');
      expect(before).toBeGreaterThan(0);
      expect(
        await asOwnerTry(`update store_studio_rollout_events set reason = 'x'`),
      ).toMatch(/studio_history_immutable/);
      expect(
        await asOwnerTry(`delete from store_studio_rollout_events`),
      ).toMatch(/studio_history_immutable/);
      expect(await asOwnerTry(`truncate store_studio_rollout_events`)).toMatch(
        /studio_history_immutable/,
      );
      // The app role has no privilege at all.
      expect(
        (
          await run(
            w.superAdmin,
            sql`delete from public.store_studio_rollout_events returning id`,
          )
        ).error,
      ).toMatch(/permission denied/);
      expect(await ownerCount('store_studio_rollout_events')).toBe(before);
    });

    it('deleting an organization still works and takes its Studio history with it', async () => {
      const eve = await createUser(t.db, 'eve@studio.test', 'Eve');
      const org = await provision(t.db, w.superAdmin, eve, 'delta-shop');
      await sup
        .put(`/platform/organizations/${org.tenant_id}/studio-rollout`, {
          enabled: true,
          reason: 'temp',
        })
        .expect(200);
      const e = await as(t, eve);
      await e
        .post('/store/attestations', {
          type: 'review_import',
          wordingKey: 'badge_upload.attestation',
          wordingVersion: 2,
          importId: crypto.randomUUID(),
        })
        .expect(201);
      await run(
        eve,
        sql`insert into public.studio_publishes (tenant_id, store_id, published_by, studio_schema_version)
        values (${org.tenant_id}::uuid, ${org.store_id}::uuid, ${eve}::uuid, 2)`,
      );
      const rows = (table: string) =>
        t.db.asOwner(async (pg) =>
          Number(
            (
              await pg.query<{ n: string }>(
                `select count(*) n from ${table} where tenant_id = $1`,
                [org.tenant_id],
              )
            ).rows[0].n,
          ),
        );
      expect(await rows('store_studio_rollout_events')).toBe(1);
      expect(await rows('attestations')).toBe(1);
      expect(await rows('studio_publishes')).toBe(1);
      const res = await run(
        w.superAdmin,
        sql`select public.platform_delete_tenant(${org.tenant_id}::uuid)`,
      );
      expect(res.error).toBe('');
      for (const table of [
        'store_studio_rollout',
        'store_studio_rollout_events',
        'attestations',
        'studio_publishes',
      ])
        expect(await rows(table), table).toBe(0);
    });
  });
});
