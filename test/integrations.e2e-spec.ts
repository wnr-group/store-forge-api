import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const ID = 'G-ABCDE12345';
const ID2 = 'G-ZZZZZ99999';

describe.skipIf(!migrationsAvailable)(
  'integrations over HTTP: Google Analytics 4 lifecycle, audit, public config, isolation (migration 0057)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let writer: Awaited<ReturnType<typeof as>>;
    let noOrg: Awaited<ReturnType<typeof as>>;
    const anon = () => request(t.app.getHttpServer());
    const api = (p: string) => `/api/v1${p}`;
    const tracking = (slug: string) =>
      anon().get(api(`/public/stores/${slug}/tracking`));
    const ga4 = (c: Awaited<ReturnType<typeof as>> = alice) => ({
      get: () => c.get('/integrations/ga4'),
      save: (measurementId: unknown = ID) =>
        c.put('/integrations/ga4', { config: { measurementId } }),
      enable: () => c.post('/integrations/ga4/enable'),
      disable: () => c.post('/integrations/ga4/disable'),
      test: () => c.post('/integrations/ga4/test'),
      remove: () => c.delete('/integrations/ga4'),
    });

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      writer = await as(t, w.members.writer, w.tenantA);
      noOrg = await as(t, w.alice);
    });
    afterEach(() => vi.unstubAllGlobals());
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('access', () => {
      it('needs a signed-in member and the organization header', async () => {
        await anon().get(api('/integrations')).expect(401);
        const res = await noOrg.get('/integrations').expect(400);
        expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        await noOrg
          .put('/integrations/ga4', { config: { measurementId: ID } })
          .expect(400);
      });

      it('lets store-settings readers look and writers change; readers cannot', async () => {
        await reader.get('/integrations').expect(200);
        await reader.get('/integrations/ga4').expect(200);
        for (const call of [
          () => ga4(reader).save(),
          () => ga4(reader).enable(),
          () => ga4(reader).disable(),
          () => ga4(reader).test(),
          () => ga4(reader).remove(),
        ])
          await call().expect(403);
        await ga4(writer).save().expect(200);
        await ga4(writer).remove().expect(200);
      });
    });

    describe('the list', () => {
      it('shows every supported integration, configured or not', async () => {
        const list = (await alice.get('/integrations').expect(200)).body.data;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          provider: 'ga4',
          name: 'Google Analytics 4',
          configured: false,
          enabled: false,
          status: 'not_configured',
          validationStatus: null,
          config: {},
          updatedAt: null,
        });
        expect(list[0].fields).toEqual([
          expect.objectContaining({
            key: 'measurementId',
            label: 'Measurement ID',
            placeholder: 'G-XXXXXXXXXX',
          }),
        ]);
      });

      it('answers 404 for a provider that does not exist', async () => {
        for (const call of [
          () => alice.get('/integrations/nope'),
          () => alice.put('/integrations/nope', { config: {} }),
          () => alice.post('/integrations/nope/enable'),
          () => alice.delete('/integrations/nope'),
        ]) {
          const res = await call().expect(404);
          expect(res.body.error.code).toBe('INTEGRATION_NOT_FOUND');
        }
      });
    });

    describe('saving and validating', () => {
      it('refuses bad settings and names the field', async () => {
        for (const bad of [
          '',
          'G-SHORT',
          'UA-12345678-1',
          'AW-1234567890',
          `${ID} `.repeat(3),
          'G-ABCDE\n12345',
        ]) {
          const res = await ga4().save(bad).expect(400);
          expect(res.body.error.code).toBe('INTEGRATION_CONFIG_INVALID');
          expect(res.body.error.details).toHaveProperty('measurementId');
        }
        await ga4().save(123).expect(400);
        await alice
          .put('/integrations/ga4', {
            config: { measurementId: ID, apiSecret: 'x' },
          })
          .expect(400);
        await alice
          .put('/integrations/ga4', { config: 'G-ABCDE12345' })
          .expect(400);
        await alice.put('/integrations/ga4', {}).expect(400);
        await alice
          .put('/integrations/ga4', {
            config: { measurementId: ID },
            tenantId: w.tenantB,
          })
          .expect(400);
        expect((await ga4().get().expect(200)).body.data.configured).toBe(
          false,
        );
      });

      it('saves a valid ID (any case) as validated but switched off', async () => {
        const r = (await ga4().save(' g-abcde12345 ').expect(200)).body.data;
        expect(r).toMatchObject({
          configured: true,
          enabled: false,
          status: 'disabled',
          validationStatus: 'valid',
          config: { measurementId: ID },
          updatedByYou: true,
        });
        expect(r.validatedAt).toBeTruthy();
        // Newest first; the writer of the earlier access test is further down.
        expect(
          r.history.slice(0, 2).map((e: { action: string }) => e.action),
        ).toEqual(['validate', 'configure']);
      });

      it('is not public until it is enabled', async () => {
        expect((await tracking('alpha-shop').expect(200)).body.data).toEqual({
          providers: [],
          consentRequired: true,
        });
      });
    });

    describe('enabling, changing, disabling and removing', () => {
      it("enables and then serves the ID to this store's storefront only", async () => {
        const r = (await ga4().enable().expect(200)).body.data;
        expect(r).toMatchObject({ enabled: true, status: 'enabled' });
        const res = await tracking('alpha-shop').expect(200);
        expect(res.body.data).toEqual({
          providers: [{ provider: 'ga4', config: { measurementId: ID } }],
          consentRequired: true,
        });
        expect(res.headers['cache-control']).toBe('public, max-age=60');
        // Another store never gets it.
        expect(
          (await tracking('beta-shop').expect(200)).body.data.providers,
        ).toEqual([]);
        await tracking('ghost-store').expect(404);
      });

      it('saving the same ID again changes nothing and writes no audit entry', async () => {
        const before = (await ga4().get().expect(200)).body.data.history.length;
        const r = (await ga4().save(ID).expect(200)).body.data;
        expect(r.enabled).toBe(true);
        expect(r.history).toHaveLength(before);
      });

      it('switches off when the ID changes, until validated and enabled again', async () => {
        const r = (await ga4().save(ID2).expect(200)).body.data;
        expect(r).toMatchObject({
          enabled: false,
          status: 'disabled',
          validationStatus: 'valid',
          config: { measurementId: ID2 },
        });
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers,
        ).toEqual([]);
        await ga4().enable().expect(200);
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers[0]
            .config.measurementId,
        ).toBe(ID2);
      });

      it('cannot be enabled while its configuration is not validated', async () => {
        // A change made behind the API's back resets validation in the database itself.
        await t.db.asOwner((pg) =>
          pg.query(
            `update marketing_integrations set config = '{"measurementId":"G-QQQQQ11111"}'::jsonb where tenant_id = $1`,
            [w.tenantA],
          ),
        );
        const state = (await ga4().get().expect(200)).body.data;
        expect(state).toMatchObject({
          enabled: false,
          validationStatus: 'unverified',
        });
        const res = await ga4().enable().expect(409);
        expect(res.body.error.code).toBe('INTEGRATION_NOT_VALID');
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers,
        ).toEqual([]);
        await ga4().save(ID).expect(200);
        await ga4().enable().expect(200);
      });

      it('disables at once and keeps the settings', async () => {
        const r = (await ga4().disable().expect(200)).body.data;
        expect(r).toMatchObject({
          enabled: false,
          configured: true,
          config: { measurementId: ID },
        });
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers,
        ).toEqual([]);
      });

      it('records who did what, never an identifier or a secret', async () => {
        const h = (await ga4().get().expect(200)).body.data.history as {
          action: string;
          note: string | null;
          byYou: boolean;
        }[];
        expect(h.length).toBeGreaterThanOrEqual(6);
        // The earlier member (a store-settings writer) is in the history too, as someone else.
        expect(h.some((e) => e.byYou)).toBe(true);
        expect(h.some((e) => !e.byYou)).toBe(true);
        const actions = h.map((e) => e.action);
        for (const a of [
          'configure',
          'validate',
          'enable',
          'update',
          'disable',
        ])
          expect(actions).toContain(a);
        const text = JSON.stringify(h);
        for (const secret of [ID, ID2, 'G-QQQQQ11111', 'secret'])
          expect(text).not.toContain(secret);
        const stored = await t.db.asOwner((pg) =>
          pg.query(`select note from marketing_integration_events`),
        );
        expect(JSON.stringify(stored.rows)).not.toContain('G-');
      });

      it('removes the settings but keeps the history, and is gone for the storefront', async () => {
        await ga4().enable().expect(200);
        await ga4().remove().expect(200);
        const r = (await ga4().get().expect(200)).body.data;
        expect(r).toMatchObject({
          configured: false,
          enabled: false,
          status: 'not_configured',
          config: {},
        });
        expect(r.history[0].action).toBe('remove');
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers,
        ).toEqual([]);
        const res = await ga4().remove().expect(404);
        expect(res.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
        expect((await ga4().enable().expect(404)).body.error.code).toBe(
          'INTEGRATION_NOT_CONFIGURED',
        );
        expect((await ga4().test().expect(404)).body.error.code).toBe(
          'INTEGRATION_NOT_CONFIGURED',
        );
      });
    });

    describe('the test', () => {
      it('reports every check and records a pass', async () => {
        await ga4().save().expect(200);
        vi.stubGlobal(
          'fetch',
          async () => new Response(`gtag "${ID}"`, { status: 200 }),
        );
        const r = (await ga4().test().expect(200)).body.data;
        expect(r.ok).toBe(true);
        expect(r.checks.map((c: { name: string }) => c.name)).toEqual([
          'Measurement ID format',
          'Google tag',
        ]);
        expect(r.note).toMatch(/Realtime/);
        expect(
          (await ga4().get().expect(200)).body.data.history[0],
        ).toMatchObject({ action: 'validate', note: 'Test passed' });
      });

      it('reports a failure, records it, and never switches a working integration off', async () => {
        await ga4().enable().expect(200);
        vi.stubGlobal(
          'fetch',
          async () => new Response('nope', { status: 503 }),
        );
        const r = (await ga4().test().expect(200)).body.data;
        expect(r.ok).toBe(false);
        const state = (await ga4().get().expect(200)).body.data;
        expect(state).toMatchObject({
          enabled: true,
          validationStatus: 'valid',
        });
        expect(state.history[0]).toMatchObject({ action: 'validate_failed' });
        expect(state.history[0].note).not.toContain(ID);
        vi.stubGlobal('fetch', async () => {
          throw new TypeError('fetch failed');
        });
        expect((await ga4().test().expect(200)).body.data.ok).toBe(false);
        await ga4().disable().expect(200);
      });
    });

    describe('isolation and secrets', () => {
      it("keeps every store's integrations to itself", async () => {
        await ga4().save().expect(200);
        await ga4().enable().expect(200);
        const theirs = (await bob.get('/integrations').expect(200)).body
          .data[0];
        expect(theirs).toMatchObject({ configured: false, config: {} });
        await ga4(bob).save(ID2).expect(200);
        await ga4(bob).enable().expect(200);
        // Each storefront gets its own ID and never the other's.
        expect(
          (await tracking('alpha-shop').expect(200)).body.data.providers[0]
            .config.measurementId,
        ).toBe(ID);
        expect(
          (await tracking('beta-shop').expect(200)).body.data.providers[0]
            .config.measurementId,
        ).toBe(ID2);
        // Changing or removing one store's never touches the other's.
        await ga4(bob).remove().expect(200);
        expect((await ga4().get().expect(200)).body.data).toMatchObject({
          configured: true,
          enabled: true,
          config: { measurementId: ID },
        });
        // The organization header cannot be pointed at a store the user does not belong to.
        const spoof = await as(t, w.alice, w.tenantB);
        await spoof.get('/integrations').expect(403);
        await spoof
          .put('/integrations/ga4', { config: { measurementId: ID } })
          .expect(403);
      });

      it('never returns a private credential from any route', async () => {
        const bodies = [
          (await alice.get('/integrations').expect(200)).text,
          (await ga4().get().expect(200)).text,
          (await ga4().save().expect(200)).text,
          (await tracking('alpha-shop').expect(200)).text,
        ];
        for (const text of bodies)
          for (const key of [
            'secret',
            'ciphertext',
            'auth_tag',
            'authTag',
            'key_version',
            'keyVersion',
            'iv"',
          ])
            expect(text.toLowerCase()).not.toContain(key.toLowerCase());
        const row = await t.db.asOwner((pg) =>
          pg.query(
            `select secret_ciphertext, iv, auth_tag, key_version from marketing_integrations where tenant_id = $1`,
            [w.tenantA],
          ),
        );
        expect(row.rows[0]).toEqual({
          secret_ciphertext: null,
          iv: null,
          auth_tag: null,
          key_version: null,
        });
      });

      it('lets a shopper-facing request see nothing but the public config', async () => {
        const { default: req } = await import('supertest');
        await req(t.app.getHttpServer())
          .get('/api/v1/integrations')
          .expect(401);
        const res = await tracking('alpha-shop').expect(200);
        expect(Object.keys(res.body.data).sort()).toEqual([
          'consentRequired',
          'providers',
        ]);
        expect(Object.keys(res.body.data.providers[0]).sort()).toEqual([
          'config',
          'provider',
        ]);
      });
    });
  },
);
