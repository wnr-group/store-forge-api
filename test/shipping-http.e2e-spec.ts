import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const NO_ID = '00000000-0000-4000-8000-000000000000';
const ORIGIN = {
  name: 'Shop',
  phone: '9000000000',
  line1: '1 Main St',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

describe.skipIf(!migrationsAvailable)(
  'shipping zones, methods and delivery options (HTTP e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
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
      reader = await as(t, w.members.reader, w.tenantA);
      writer = await as(t, w.members.writer, w.tenantA);
      noOrg = await as(t, w.alice);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    const reads = (c: Awaited<ReturnType<typeof as>>) => [
      () => c.get('/shipping/zones'),
      () => c.get(`/shipping/zones/${NO_ID}`),
      () => c.get('/shipping/methods'),
      () => c.get(`/shipping/methods/${NO_ID}`),
      () => c.get('/shipping/origin'),
      () =>
        c.post('/shipping/preview', {
          destination: { state: 'Goa', postalCode: '403001' },
          subtotalMinor: 100,
          weightGrams: 100,
        }),
    ];
    const writes = (c: Awaited<ReturnType<typeof as>>) => [
      () =>
        c.post('/shipping/zones', { name: 'Z', areas: { states: ['Goa'] } }),
      () =>
        c.put(`/shipping/zones/${NO_ID}`, {
          name: 'Z',
          areas: { states: ['Goa'] },
        }),
      () => c.delete(`/shipping/zones/${NO_ID}`),
      () =>
        c.post('/shipping/methods', {
          zoneId: NO_ID,
          name: 'M',
          pricingType: 'free',
        }),
      () =>
        c.put(`/shipping/methods/${NO_ID}`, {
          zoneId: NO_ID,
          name: 'M',
          pricingType: 'free',
        }),
      () => c.delete(`/shipping/methods/${NO_ID}`),
      () => c.put('/shipping/origin', ORIGIN),
    ];

    describe('access', () => {
      it('requires the organization header on every route', async () => {
        for (const call of [
          ...reads(noOrg),
          ...writes(noOrg),
          () =>
            noOrg.post('/shipping/carrier-quotes', {
              destinationPostalCode: '400001',
              weightGrams: 1,
              paymentMode: 'prepaid',
            }),
        ]) {
          const res = await call();
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        }
      });

      it('is closed to anyone who is not signed in', async () => {
        await anon().get('/api/v1/shipping/zones').expect(401);
        await anon().post('/api/v1/shipping/zones').send({}).expect(401);
        await anon().get('/api/v1/shipping/origin').expect(401);
      });

      it('lets a member with read access to the store settings look, but not change anything', async () => {
        for (const call of reads(reader))
          expect((await call()).status).not.toBe(403);
        for (const call of writes(reader))
          expect((await call()).status).toBe(403);
      });

      it('lets a member with write access to the store settings change shipping, but not compare carriers', async () => {
        await writer
          .post('/shipping/zones', {
            name: 'Writer made this',
            areas: { postalCodes: ['110001'] },
          })
          .expect(201);
        await writer
          .post('/shipping/carrier-quotes', {
            destinationPostalCode: '400001',
            weightGrams: 1,
            paymentMode: 'prepaid',
          })
          .expect(403);
      });
    });

    describe('zones and methods', () => {
      let zoneId: string;
      let methodId: string;

      it('validate the body and name every problem', async () => {
        await alice.post('/shipping/zones', {}).expect(400);
        await alice
          .post('/shipping/zones', { name: 'Z', areas: 'all' })
          .expect(400);
        await alice
          .post('/shipping/zones', { name: 'Z', areas: { states: 'Goa' } })
          .expect(400);
        await alice
          .post('/shipping/zones', {
            name: 'Z',
            areas: { states: ['Goa'] },
            tenantId: w.tenantB,
          })
          .expect(400);
        const res = await alice
          .post('/shipping/zones', {
            name: 'Z',
            areas: { states: ['Atlantis'], postalCodes: ['12'] },
          })
          .expect(400);
        expect(res.body.error.code).toBe('ZONE_AREAS_INVALID');
        expect(Object.keys(res.body.error.details).sort()).toEqual([
          'postalCodes.0',
          'states.0',
        ]);
      });

      it('create a zone, then refuse a second that clashes with it', async () => {
        const created = await alice
          .post('/shipping/zones', {
            name: 'Karnataka',
            areas: { states: ['Karnataka'] },
            codAllowed: false,
          })
          .expect(201);
        zoneId = created.body.data.id;
        expect(created.body.data).toMatchObject({
          name: 'Karnataka',
          enabled: true,
          codAllowed: false,
        });
        const clash = await alice
          .post('/shipping/zones', {
            name: 'Also Karnataka',
            areas: { states: ['29'] },
          })
          .expect(409);
        expect(clash.body.error.code).toBe('ZONE_CONFLICT');
        expect(clash.body.error.details.areas).toContain('"Karnataka"');
      });

      it('create methods and refuse the ones that make no sense', async () => {
        await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'Standard',
            pricingType: 'flat',
          })
          .expect(400);
        await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'M',
            pricingType: 'teleport',
          })
          .expect(400);
        await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'M',
            pricingType: 'flat',
            flatRateMinor: -1,
          })
          .expect(400);
        const bad = await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'W',
            pricingType: 'weight',
            tiers: [{ from: 0, to: 100, rateMinor: 1 }],
          })
          .expect(400);
        expect(bad.body.error.code).toBe('METHOD_INVALID');
        expect(bad.body.error.details.tiers).toMatch(/no upper limit/);
        const ok = await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'Standard',
            pricingType: 'flat',
            flatRateMinor: 4000,
            estimatedDaysMin: 2,
            estimatedDaysMax: 4,
          })
          .expect(201);
        methodId = ok.body.data.id;
        expect(ok.body.data).toMatchObject({
          flatRateMinor: 4000,
          zoneName: 'Karnataka',
          tiers: [],
        });
        await alice
          .post('/shipping/methods', {
            zoneId,
            name: 'standard',
            pricingType: 'free',
          })
          .expect(409);
      });

      it('list, show, change and use the pickup address', async () => {
        expect(
          (await alice.get('/shipping/zones').expect(200)).body.data[0],
        ).toMatchObject({ name: 'Karnataka', methodCount: 1 });
        expect(
          (await alice.get(`/shipping/methods?zoneId=${zoneId}`).expect(200))
            .body.data,
        ).toHaveLength(1);
        await alice.get('/shipping/methods?zoneId=not-a-uuid').expect(400);
        await alice
          .put(`/shipping/methods/${methodId}`, {
            zoneId,
            name: 'Standard',
            pricingType: 'flat',
            flatRateMinor: 4500,
          })
          .expect(200);
        expect(
          (await alice.get(`/shipping/methods/${methodId}`).expect(200)).body
            .data.flatRateMinor,
        ).toBe(4500);
        expect(
          (await alice.get('/shipping/origin').expect(200)).body.data
            .configured,
        ).toBe(false);
        expect(
          (await alice.put('/shipping/origin', ORIGIN).expect(200)).body.data,
        ).toMatchObject({
          configured: true,
          state: 'Karnataka',
          postalCode: '560001',
        });
        await alice
          .put('/shipping/origin', { ...ORIGIN, postalCode: '12' })
          .expect(400);
        await alice
          .put('/shipping/origin', { ...ORIGIN, state: 'Atlantis' })
          .expect(400);
      });

      it('preview what a shopper would be offered', async () => {
        const res = await alice
          .post('/shipping/preview', {
            destination: {
              state: 'Karnataka',
              city: 'Mysuru',
              postalCode: '570001',
            },
            subtotalMinor: 100000,
            weightGrams: 500,
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          configured: true,
          deliverable: true,
          zone: { name: 'Karnataka', codAllowed: false },
        });
        expect(res.body.data.options[0]).toMatchObject({
          name: 'Standard',
          chargeMinor: 4500,
          codAllowed: false,
        });
        expect(res.body.data.options[0]).not.toHaveProperty('carrierQuote');
        await alice
          .post('/shipping/preview', {
            destination: { state: 'Atlantis', postalCode: '570001' },
            subtotalMinor: 1,
            weightGrams: 1,
          })
          .expect(400);
        await alice
          .post('/shipping/preview', {
            destination: { state: 'Goa', postalCode: '403001' },
            subtotalMinor: -1,
            weightGrams: 1,
          })
          .expect(400);
        const away = await alice
          .post('/shipping/preview', {
            destination: { state: 'Goa', postalCode: '403001' },
            subtotalMinor: 100,
            weightGrams: 1,
          })
          .expect(200);
        expect(away.body.data).toMatchObject({
          deliverable: false,
          zone: null,
        });
      });

      it('keep one organization’s shipping apart from another’s', async () => {
        expect(
          (await bob.get('/shipping/zones').expect(200)).body.data,
        ).toEqual([]);
        await bob.get(`/shipping/zones/${zoneId}`).expect(404);
        await bob.delete(`/shipping/zones/${zoneId}`).expect(404);
        await bob.get(`/shipping/methods/${methodId}`).expect(404);
        expect(
          (await bob.get('/shipping/origin').expect(200)).body.data.configured,
        ).toBe(false);
        const theirs = await bob
          .post('/shipping/zones', {
            name: 'Karnataka',
            areas: { states: ['Karnataka'] },
          })
          .expect(201);
        expect(theirs.body.data.id).not.toBe(zoneId);
      });

      it('compare carriers needs a pickup address, and says so (Owner only)', async () => {
        const res = await bob
          .post('/shipping/carrier-quotes', {
            destinationPostalCode: '400001',
            weightGrams: 500,
            paymentMode: 'prepaid',
          })
          .expect(400);
        expect(res.body.error.code).toBe('ORIGIN_MISSING');
        await alice
          .post('/shipping/carrier-quotes', {
            destinationPostalCode: '40',
            weightGrams: 500,
            paymentMode: 'prepaid',
          })
          .expect(400);
        const none = await alice
          .post('/shipping/carrier-quotes', {
            destinationPostalCode: '400001',
            weightGrams: 500,
            paymentMode: 'prepaid',
          })
          .expect(200);
        expect(none.body.data).toMatchObject({
          candidates: [],
          skipped: [],
          mode: 'manual',
        });
      });
    });

    describe('product weight', () => {
      it('is saved with a product, changed with an update, and validated', async () => {
        const created = await alice
          .post('/products', {
            name: 'Weighty',
            price: '100',
            status: 'active',
            quantity: 5,
            weightGrams: 750,
          })
          .expect(201);
        expect(created.body.data.weightGrams).toBe(750);
        const id = created.body.data.id;
        expect(
          (
            await alice
              .patch(`/products/${id}`, { weightGrams: 900 })
              .expect(200)
          ).body.data.weightGrams,
        ).toBe(900);
        expect(
          (
            await alice
              .patch(`/products/${id}`, { name: 'Weighty 2' })
              .expect(200)
          ).body.data.weightGrams,
        ).toBe(900); // kept
        await alice.patch(`/products/${id}`, { weightGrams: -1 }).expect(400);
        await alice
          .patch(`/products/${id}`, { weightGrams: 2_000_000 })
          .expect(400);
        const plain = await alice
          .post('/products', { name: 'No weight', price: '10' })
          .expect(201);
        expect(plain.body.data.weightGrams).toBe(0);
        const copy = await alice.post(`/products/${id}/duplicate`).expect(201);
        expect(copy.body.data.weightGrams).toBe(900);
      });
    });

    describe('the storefront', () => {
      it('says nothing needs choosing for a store without zones, and 404 for an unknown store', async () => {
        await bob
          .post('/products', {
            name: 'Bob thing',
            price: '50',
            status: 'active',
            quantity: 5,
            weightGrams: 200,
          })
          .expect(201);
        await anon()
          .delete('/api/v1/shipping/zones/' + NO_ID)
          .expect(401);
        const bobZones = (await bob.get('/shipping/zones').expect(200)).body
          .data as { id: string }[];
        for (const z of bobZones)
          await bob.delete(`/shipping/zones/${z.id}`).expect(200);
        const res = await anon()
          .post('/api/v1/public/stores/beta-shop/shipping/options')
          .send({
            address: { state: 'Goa', postalCode: '403001' },
            lines: [{ productSlug: 'bob-thing', quantity: 1 }],
          })
          .expect(200);
        expect(res.body.data).toEqual({
          configured: false,
          deliverable: true,
          zone: null,
          options: [],
          unavailable: [],
          reason: null,
        });
        await anon()
          .post('/api/v1/public/stores/ghost-store/shipping/options')
          .send({
            address: { state: 'Goa', postalCode: '403001' },
            lines: [{ productSlug: 'x', quantity: 1 }],
          })
          .expect(404);
      });

      it('prices the cart from the database and offers the delivery options of the address’s zone', async () => {
        await alice
          .post('/products', {
            name: 'Mug',
            price: '500',
            status: 'active',
            quantity: 50,
            weightGrams: 400,
          })
          .expect(201);
        const res = await anon()
          .post('/api/v1/public/stores/alpha-shop/shipping/options')
          .send({
            address: {
              state: 'Karnataka',
              city: 'Mysuru',
              postalCode: '570001',
            },
            lines: [{ productSlug: 'mug', quantity: 2 }],
          })
          .expect(200);
        expect(res.body.data).toMatchObject({
          configured: true,
          deliverable: true,
          zone: { name: 'Karnataka' },
        });
        expect(res.body.data.options).toEqual([
          expect.objectContaining({
            name: 'Standard',
            chargeMinor: 4500,
            free: false,
            estimatedDays: null,
            codAllowed: false,
            carrier: null,
          }),
        ]);
        expect(JSON.stringify(res.body)).not.toContain('carrierQuote');
        const away = await anon()
          .post('/api/v1/public/stores/alpha-shop/shipping/options')
          .send({
            address: { state: 'Goa', postalCode: '403001' },
            lines: [{ productSlug: 'mug', quantity: 1 }],
          })
          .expect(200);
        expect(away.body.data).toMatchObject({
          deliverable: false,
          options: [],
        });
      });

      it('reports cart problems the same way as placing an order, and validates the request', async () => {
        const issues = await anon()
          .post('/api/v1/public/stores/alpha-shop/shipping/options')
          .send({
            address: { state: 'Karnataka', postalCode: '570001' },
            lines: [{ productSlug: 'no-such-product', quantity: 1 }],
          })
          .expect(409);
        expect(issues.body.error.code).toBe('CHECKOUT_ISSUES');
        const post = (body: object) =>
          anon()
            .post('/api/v1/public/stores/alpha-shop/shipping/options')
            .send(body);
        await post({ lines: [{ productSlug: 'mug', quantity: 1 }] }).expect(
          400,
        );
        await post({
          address: { state: 'Karnataka', postalCode: '570001' },
          lines: [],
        }).expect(400);
        await post({
          address: { state: 'Karnataka', postalCode: '12' },
          lines: [{ productSlug: 'mug', quantity: 1 }],
        }).expect(400);
        await post({
          address: { state: 'Atlantis', postalCode: '570001' },
          lines: [{ productSlug: 'mug', quantity: 1 }],
        }).expect(400);
        await post({
          address: { state: 'Karnataka', postalCode: '570001' },
          lines: [{ productSlug: 'mug', quantity: 0 }],
        }).expect(400);
      });

      it('answers 400 (not 500) when a required part of the request is missing altogether', async () => {
        const options = (body: object) =>
          anon()
            .post('/api/v1/public/stores/alpha-shop/shipping/options')
            .send(body);
        const missing = await options({
          lines: [{ productSlug: 'mug', quantity: 1 }],
        }).expect(400);
        expect(JSON.stringify(missing.body)).toContain(
          'Enter the delivery address.',
        );
        await options({
          address: null,
          lines: [{ productSlug: 'mug', quantity: 1 }],
        }).expect(400);
        const order = (body: object) =>
          anon()
            .post('/api/v1/public/stores/alpha-shop/orders')
            .set('Idempotency-Key', 'http-missing-0001')
            .send(body);
        const base = {
          lines: [{ productSlug: 'mug', quantity: 1 }],
          customer: { fullName: 'A', email: 'a@b.co', phone: '9876543210' },
          shippingAddress: {
            fullName: 'A',
            phone: '9876543210',
            line1: '1',
            city: 'C',
            state: 'Karnataka',
            postalCode: '570001',
          },
          paymentMethod: 'cod',
        };
        const { customer: _c, ...noCustomer } = base;
        const { shippingAddress: _a, ...noAddress } = base;
        await order(noCustomer).expect(400);
        await order(noAddress).expect(400);
        await alice
          .post('/shipping/preview', { subtotalMinor: 1, weightGrams: 1 })
          .expect(400);
        await alice.post('/shipping/zones', { name: 'No areas' }).expect(400);
      });

      it('places an order with the chosen option and refuses an invalid or missing one', async () => {
        const options = await anon()
          .post('/api/v1/public/stores/alpha-shop/shipping/options')
          .send({
            address: {
              state: 'Karnataka',
              city: 'Mysuru',
              postalCode: '570001',
            },
            lines: [{ productSlug: 'mug', quantity: 1 }],
          })
          .expect(200);
        const methodId = options.body.data.options[0].methodId as string;
        const order = (extra: object = {}) => ({
          lines: [{ productSlug: 'mug', quantity: 1 }],
          customer: {
            fullName: 'Asha Rao',
            email: 'asha@example.test',
            phone: '9876543210',
          },
          shippingAddress: {
            fullName: 'Asha Rao',
            phone: '9876543210',
            line1: '1 St',
            city: 'Mysuru',
            state: 'Karnataka',
            postalCode: '570001',
          },
          paymentMethod: 'cod',
          ...extra,
        });
        const place = (body: object, key: string) =>
          anon()
            .post('/api/v1/public/stores/alpha-shop/orders')
            .set('Idempotency-Key', key)
            .send(body);
        const asOwner = await as(t, w.alice, w.tenantA);
        await asOwner
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 0,
            feeMinor: 0,
          })
          .expect(200);

        // Karnataka forbids cash on delivery, so this order is refused for that reason (not because of the option).
        const cod = await place(
          order({ shippingMethodId: methodId }),
          'http-ship-key-0001',
        ).expect(409);
        expect(cod.body.error.code).toBe('COD_NOT_AVAILABLE');
        expect(
          (await place(order(), 'http-ship-key-0002').expect(400)).body.error
            .code,
        ).toBe('SHIPPING_METHOD_REQUIRED');
        expect(
          (
            await place(
              order({ shippingMethodId: NO_ID }),
              'http-ship-key-0003',
            ).expect(409)
          ).body.error.code,
        ).toBe('SHIPPING_METHOD_UNAVAILABLE');
        await place(
          order({ shippingMethodId: 'not-a-uuid' }),
          'http-ship-key-0004',
        ).expect(400);
        // The price cannot be supplied by the browser.
        await place(
          order({ shippingMethodId: methodId, shippingMinor: 1 }),
          'http-ship-key-0005',
        ).expect(400);
      });
    });
  },
);
