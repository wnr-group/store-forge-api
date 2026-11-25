import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const PASSWORD = 'http-leak-sentinel-PASSWORD-91';
const TOKEN = 'http-leak-sentinel-TOKEN-77';

describe.skipIf(!migrationsAvailable)(
  'shipping carrier routes (HTTP e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let writer: Awaited<ReturnType<typeof as>>;
    let noOrg: Awaited<ReturnType<typeof as>>;
    const anon = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      writer = await as(t, w.members.writer, w.tenantA);
      noOrg = await as(t, w.alice);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const everyRoute = (c: Awaited<ReturnType<typeof as>>) => [
      () => c.get('/shipping/carriers'),
      () => c.put('/shipping/carriers/shiprocket', { values: {} }),
      () => c.post('/shipping/carriers/shiprocket/test', { values: {} }),
      () => c.post('/shipping/carriers/shiprocket/verify'),
      () => c.put('/shipping/carriers/shiprocket/enabled', { enabled: false }),
      () =>
        c.put('/shipping/carriers/shiprocket/default', { isDefault: false }),
      () => c.delete('/shipping/carriers/shiprocket'),
      () => c.get('/shipping/carrier-events'),
      () => c.get('/shipping/preferences'),
      () =>
        c.put('/shipping/preferences', {
          selectionMode: 'manual',
          strategy: 'lowest_cost',
        }),
    ];

    describe('access', () => {
      it('requires the organization header on every route', async () => {
        for (const call of everyRoute(noOrg)) {
          const res = await call();
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        }
      });

      it('is closed to anyone who is not signed in', async () => {
        for (const path of [
          '/shipping/carriers',
          '/shipping/carrier-events',
          '/shipping/preferences',
        ])
          await anon().get(`/api/v1${path}`).expect(401);
        await anon()
          .post('/api/v1/shipping/carriers/shiprocket/verify')
          .expect(401);
        await anon().delete('/api/v1/shipping/carriers/shiprocket').expect(401);
      });

      it('is Owner only, even for a member who can edit the store settings', async () => {
        for (const call of everyRoute(writer))
          expect((await call()).status).toBe(403);
      });
    });

    describe('connecting a carrier', () => {
      it('lists every carrier with what it can do and what it needs, none connected', async () => {
        const res = await alice.get('/shipping/carriers').expect(200);
        expect(res.body.data.map((c: { code: string }) => c.code)).toEqual([
          'shiprocket',
          'delhivery',
          'bluedart',
        ]);
        const bluedart = res.body.data.find(
          (c: { code: string }) => c.code === 'bluedart',
        );
        expect(bluedart).toMatchObject({
          integrationStatus: 'unverified',
          capabilities: { rateQuotes: false, labels: false },
        });
        expect(
          res.body.data.every(
            (c: { connection: { connected: boolean } }) =>
              !c.connection.connected,
          ),
        ).toBe(true);
      });

      it('validates the body and each setting', async () => {
        await alice.put('/shipping/carriers/shiprocket', {}).expect(400);
        await alice
          .put('/shipping/carriers/shiprocket', { values: 'nope' })
          .expect(400);
        await alice
          .put('/shipping/carriers/shiprocket', {
            values: {},
            tenantId: w.tenantB,
          })
          .expect(400);
        const res = await alice
          .put('/shipping/carriers/shiprocket', {
            values: { email: 'a@b.co', surprise: 'x' },
          })
          .expect(400);
        expect(res.body.error.code).toBe('CARRIER_SETTINGS_INVALID');
        expect(Object.keys(res.body.error.details).sort()).toEqual([
          'password',
          'pickupLocation',
          'surprise',
        ]);
      });

      it('saves a carrier, never returns a secret, and keeps it out of every later response', async () => {
        const saved = await alice
          .put('/shipping/carriers/shiprocket', {
            values: {
              email: 'api@shop.test',
              password: PASSWORD,
              pickupLocation: 'Primary',
            },
          })
          .expect(200);
        expect(saved.body.data.connection).toMatchObject({
          connected: true,
          enabled: false,
          verificationStatus: 'unverified',
          settings: { email: 'api@shop.test', pickupLocation: 'Primary' },
          secretFieldsSaved: ['password'],
        });
        await alice
          .put('/shipping/carriers/delhivery', {
            values: {
              apiToken: TOKEN,
              pickupLocation: 'Warehouse',
              environment: 'staging',
            },
          })
          .expect(200);

        const everything = [
          JSON.stringify(saved.body),
          JSON.stringify(
            (await alice.get('/shipping/carriers').expect(200)).body,
          ),
          JSON.stringify(
            (await alice.get('/shipping/carrier-events').expect(200)).body,
          ),
          JSON.stringify(
            (await alice.get('/shipping/preferences').expect(200)).body,
          ),
        ].join('\n');
        expect(everything).not.toContain(PASSWORD);
        expect(everything).not.toContain(TOKEN);
        expect(everything).not.toMatch(/ciphertext|auth_tag/i);
      });

      it('keeps one organization’s connection out of another’s', async () => {
        const theirs = await bob.get('/shipping/carriers').expect(200);
        expect(
          theirs.body.data.every(
            (c: { connection: { connected: boolean } }) =>
              !c.connection.connected,
          ),
        ).toBe(true);
        await bob.post('/shipping/carriers/shiprocket/verify').expect(404);
        await bob.delete('/shipping/carriers/shiprocket').expect(404);
      });

      it('answers 404 for an unknown carrier', async () => {
        await alice.put('/shipping/carriers/fedex', { values: {} }).expect(404);
        await alice.post('/shipping/carriers/fedex/verify').expect(404);
        await alice.delete('/shipping/carriers/fedex').expect(404);
      });
    });

    describe('state changes', () => {
      it('refuses to turn a carrier on before a successful check', async () => {
        const res = await alice
          .put('/shipping/carriers/shiprocket/enabled', { enabled: true })
          .expect(409);
        expect(res.body.error.code).toBe('CARRIER_NOT_VERIFIED');
        await alice
          .put('/shipping/carriers/shiprocket/default', { isDefault: true })
          .expect(409);
      });

      it('asks before turning on an unverified integration, and validates the body', async () => {
        await alice
          .put('/shipping/carriers/bluedart/enabled', { enabled: true })
          .expect(404); // not connected: nothing to acknowledge
        await alice
          .put('/shipping/carriers/shiprocket/enabled', { enabled: 'yes' })
          .expect(400);
        await alice
          .put('/shipping/carriers/shiprocket/default', { isDefault: 'maybe' })
          .expect(400);
      });
    });

    describe('history and preferences', () => {
      it('shows who changed what, and pages', async () => {
        const res = await alice
          .get('/shipping/carrier-events?limit=1')
          .expect(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
        expect(res.body.data[0]).toMatchObject({
          action: 'connect',
          actorName: 'Alice Owner',
        });
        await alice.get('/shipping/carrier-events?action=nonsense').expect(400);
        const filtered = await alice
          .get('/shipping/carrier-events?action=connect')
          .expect(200);
        expect(
          filtered.body.data.every(
            (e: { action: string }) => e.action === 'connect',
          ),
        ).toBe(true);
        expect(
          (await bob.get('/shipping/carrier-events').expect(200)).body.data,
        ).toEqual([]);
      });

      it('reads and saves the selection preferences, and refuses unknown values', async () => {
        expect(
          (await alice.get('/shipping/preferences').expect(200)).body.data,
        ).toMatchObject({
          selectionMode: 'manual',
          strategy: 'lowest_cost',
          activeCarrierCount: 0,
        });
        const saved = await alice
          .put('/shipping/preferences', {
            selectionMode: 'automatic',
            strategy: 'fastest',
          })
          .expect(200);
        expect(saved.body.data).toMatchObject({
          selectionMode: 'automatic',
          strategy: 'fastest',
        });
        await alice
          .put('/shipping/preferences', {
            selectionMode: 'robot',
            strategy: 'fastest',
          })
          .expect(400);
        await alice
          .put('/shipping/preferences', { selectionMode: 'manual' })
          .expect(400);
        await alice
          .put('/shipping/preferences', {
            selectionMode: 'manual',
            strategy: 'fastest',
            extra: 1,
          })
          .expect(400);
        expect(
          (await bob.get('/shipping/preferences').expect(200)).body.data
            .selectionMode,
        ).toBe('manual');
      });
    });

    describe('disconnecting', () => {
      it('removes the carrier and its history entry appears', async () => {
        await alice.delete('/shipping/carriers/delhivery').expect(200);
        const list = await alice.get('/shipping/carriers').expect(200);
        expect(
          list.body.data.find((c: { code: string }) => c.code === 'delhivery')
            .connection.connected,
        ).toBe(false);
        const events = await alice.get('/shipping/carrier-events').expect(200);
        expect(events.body.data[0]).toMatchObject({
          providerCode: 'delhivery',
          action: 'disconnect',
        });
        await alice.delete('/shipping/carriers/delhivery').expect(404);
      });
    });
  },
);
