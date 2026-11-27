import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { registerShopper } from './support/shopper.js';
import { FakeCarrier } from './support/fake-carrier.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { addShiprocketShipping, SR } from './support/shipments-world.js';
import { SR_CREDS } from './support/shipping-world.js';
import { seedWorld, type World } from './support/world.js';
import { CarrierHttp } from '../src/modules/shipping/providers/carrier-http.js';
import { ShippingProviderRegistry } from '../src/modules/shipping/providers/provider-registry.js';

const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef-xyz';
const NO_ID = '00000000-0000-4000-8000-000000000000';
const ORIGIN = {
  name: 'Alpha Shop',
  phone: '9000000000',
  line1: '1 Main St',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

describe.skipIf(!migrationsAvailable)(
  'shipments, labels, carrier webhooks and the tracking job (HTTP e2e)',
  () => {
    let t: TestApp;
    const shopper: Record<string, string> = {};
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let noOrg: Awaited<ReturnType<typeof as>>;
    let sr: ReturnType<typeof addShiprocketShipping>;
    const anon = () => request(t.app.getHttpServer());
    const api = (path: string) => `/api/v1${path}`;

    /** Places a cash-on-delivery order through the public API and returns its id, number and token. */
    async function place(qty = 1) {
      const res = await anon()
        .post(api('/public/stores/alpha-shop/orders'))
        .set('X-Customer-Session', shopper['alpha-shop'])
        .set('Idempotency-Key', randomBytes(12).toString('hex'))
        .send({
          lines: [{ productSlug: 'http-ship-mug', quantity: qty }],
          customer: {
            fullName: 'Asha Rao',
            email: 'asha@example.test',
            phone: '9876543210',
          },
          shippingAddress: {
            fullName: 'Asha Rao',
            phone: '9876543210',
            line1: '12 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
          paymentMethod: 'cod',
        })
        .expect(201);
      const number = res.body.data.orderNumber as number;
      const id = await t.db.asOwner(
        async (pg) =>
          (
            await pg.query<{ id: string }>(
              'select id from orders where tenant_id = $1 and order_number = $2',
              [w.tenantA, number],
            )
          ).rows[0].id,
      );
      return { id, number, token: res.body.data.accessToken as string };
    }

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      process.env.CRON_SECRET = CRON_SECRET;
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) =>
        pg.query(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status, weight_grams) values ($1, 'Mug', 'http-ship-mug', 50000, 500, 'active', 400)`,
          [w.tenantA],
        ),
      );
      t = await createTestApp(db);
      shopper['alpha-shop'] = await registerShopper(t.app, 'alpha-shop');

      // Every carrier call in the app goes to a scriptable fake.
      const fake = new FakeCarrier();
      fake.on('POST', `${SR}/auth/login`, { body: { token: 'sr-token-1234' } });
      fake.on('GET', `${SR}/settings/company/pickup`, {
        body: { data: { shipping_address: [{ pickup_location: 'Primary' }] } },
      });
      sr = addShiprocketShipping(fake);
      (
        t.app.get(CarrierHttp, { strict: false }) as unknown as {
          fetchImpl: typeof fetch;
        }
      ).fetchImpl = fake.fetch;

      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      noOrg = await as(t, w.alice);

      await alice.put('/shipping/origin', ORIGIN).expect(200);
      await alice
        .put('/payments/cod', { enabled: true, minOrderMinor: 0, feeMinor: 0 })
        .expect(200);
      await alice
        .put('/shipping/carriers/shiprocket', { values: SR_CREDS })
        .expect(200);
      await alice.post('/shipping/carriers/shiprocket/verify').expect(200);
      await alice
        .put('/shipping/carriers/shiprocket/enabled', { enabled: true })
        .expect(200);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('access', () => {
      it('needs the organization header and a signed-in user', async () => {
        for (const call of [
          () => noOrg.get('/shipments'),
          () => noOrg.get(`/shipments/${NO_ID}`),
          () => noOrg.get(`/orders/${NO_ID}/shipments`),
          () => noOrg.post(`/orders/${NO_ID}/shipments`, {}),
          () => noOrg.post(`/shipments/${NO_ID}/cancel`),
        ]) {
          const res = await call();
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        }
        await anon().get(api('/shipments')).expect(401);
        await anon()
          .post(api(`/orders/${NO_ID}/shipments`))
          .send({})
          .expect(401);
        await anon()
          .get(api(`/shipments/${NO_ID}/label/file`))
          .expect(401);
      });

      it('lets someone with read access to orders look, but only someone with write access change anything', async () => {
        await reader.get('/shipments').expect(200);
        await reader.get(`/orders/${NO_ID}/shipments`).expect(404);
        await reader.get(`/shipments/${NO_ID}`).expect(404);
        await reader.get(`/shipments/${NO_ID}/label`).expect(404);
        await reader.post(`/orders/${NO_ID}/shipments`, {}).expect(403);
        for (const action of ['retry', 'cancel', 'refresh', 'label'])
          await reader.post(`/shipments/${NO_ID}/${action}`).expect(403);
      });
    });

    describe('the shipment flow', () => {
      let order: Awaited<ReturnType<typeof place>>;
      let shipmentId: string;
      let awb: string;

      it('validates the request', async () => {
        order = await place();
        const create = (body: object) =>
          alice.post(`/orders/${order.id}/shipments`, body);
        await create({ items: 'all' }).expect(400);
        await create({ items: [{ orderItemId: 'nope', quantity: 1 }] }).expect(
          400,
        );
        await create({ items: [{ orderItemId: NO_ID, quantity: 0 }] }).expect(
          400,
        );
        await create({ weightGrams: -5 }).expect(400);
        await create({ weightGrams: 2_000_000 }).expect(400);
        await create({ lengthCm: 0, breadthCm: 1, heightCm: 1 }).expect(400);
        await create({ providerCode: 'Not A Code' }).expect(400);
        await create({ price: 1 }).expect(400); // nothing can be supplied that the server decides
        await alice.post('/orders/not-a-uuid/shipments', {}).expect(400);
        await alice
          .post(`/orders/${NO_ID}/shipments`, { providerCode: 'shiprocket' })
          .expect(404);
      });

      it('asks for a carrier when nothing chooses one', async () => {
        const res = await alice
          .post(`/orders/${order.id}/shipments`, {})
          .expect(400);
        expect(res.body.error).toMatchObject({
          code: 'CARRIER_REQUIRED',
          details: { providerCode: 'Choose a carrier.' },
        });
      });

      it('books the parcel and returns it with its history', async () => {
        const res = await alice
          .post(`/orders/${order.id}/shipments`, { providerCode: 'shiprocket' })
          .expect(201);
        const sh = res.body.data;
        shipmentId = sh.id;
        awb = sh.awb;
        expect(sh).toMatchObject({
          status: 'created',
          providerCode: 'shiprocket',
          orderNumber: order.number,
          paymentMode: 'cod',
          weightGrams: 400,
          courierName: 'Xpressbees Surface',
        });
        expect(sh.events[0].status).toBe('created');
        expect(Object.keys(sh)).not.toContain('providerOrderId');
        expect(
          (await alice.get(`/orders/${order.id}`).expect(200)).body.data,
        ).toMatchObject({
          status: 'ready_to_ship',
          fulfillmentStatus: 'fulfilled',
        });
      });

      it('lists and shows it', async () => {
        const list = await alice
          .get('/shipments?status=created&providerCode=shiprocket')
          .expect(200);
        expect(list.body.data.map((x: { id: string }) => x.id)).toContain(
          shipmentId,
        );
        expect(list.body.meta.total).toBeGreaterThan(0);
        await alice.get('/shipments?status=nonsense').expect(400);
        await alice.get('/shipments?providerCode=NOPE').expect(400);
        expect(
          (await alice.get(`/orders/${order.id}/shipments`).expect(200)).body
            .data,
        ).toHaveLength(1);
        expect(
          (await alice.get(`/shipments/${shipmentId}`).expect(200)).body.data
            .items,
        ).toEqual([expect.objectContaining({ quantity: 1 })]);
        await alice.get('/shipments/not-a-uuid').expect(400);
      });

      it('keeps the order from being cancelled underneath its parcel', async () => {
        const res = await alice
          .post(`/orders/${order.id}/cancel`, { reason: 'changed my mind' })
          .expect(409);
        expect(res.body.error.code).toBe('ORDER_HAS_SHIPMENT');
        await alice
          .post(`/orders/${order.id}/status`, { status: 'delivered' })
          .expect(409);
      });

      it('refreshes tracking on demand and the order follows', async () => {
        sr.say(awb, 'In Transit');
        const res = await alice
          .post(`/shipments/${shipmentId}/refresh`)
          .expect(200);
        expect(res.body.data.status).toBe('in_transit');
        expect(
          res.body.data.events.some(
            (e: { source: string }) => e.source === 'carrier_api',
          ),
        ).toBe(true);
        expect(
          (await alice.get(`/orders/${order.id}`).expect(200)).body.data.status,
        ).toBe('shipped');
        const view = await anon()
          .get(api(`/public/stores/alpha-shop/orders/${order.number}`))
          .set('X-Order-Token', order.token)
          .expect(200);
        expect(view.body.data.shipments[0]).toMatchObject({
          status: 'in_transit',
          awb,
          courierName: 'Xpressbees Surface',
        });
      });

      it('cannot cancel a parcel the carrier already has', async () => {
        const res = await alice
          .post(`/shipments/${shipmentId}/cancel`)
          .expect(409);
        expect(res.body.error.code).toBe('SHIPMENT_NOT_CANCELLABLE');
      });

      it('downloads a stored label as a PDF, privately', async () => {
        const registry = t.app.get(ShippingProviderRegistry, { strict: false });
        const spy = vi
          .spyOn(registry.get('shiprocket'), 'generateShippingLabel')
          .mockResolvedValue({
            pdfBase64: Buffer.from('%PDF-1.4 http label').toString('base64'),
          });
        await alice.get(`/shipments/${shipmentId}/label/file`).expect(404);
        const made = await alice
          .post(`/shipments/${shipmentId}/label`)
          .expect(200);
        expect(made.body.data).toMatchObject({ available: true, stored: true });
        spy.mockRestore();

        const file = await alice
          .get(`/shipments/${shipmentId}/label/file`)
          .buffer(true)
          .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
          });
        expect(file.status).toBe(200);
        expect(file.headers['content-type']).toMatch(/application\/pdf/);
        expect(file.headers['content-disposition']).toMatch(
          /attachment; filename="shipping-label-/,
        );
        expect(file.headers['cache-control']).toMatch(/no-store/);
        expect((file.body as Buffer).toString('latin1')).toBe(
          '%PDF-1.4 http label',
        );
        // A reader may download it too (orders read access); nobody outside the organization may.
        await reader.get(`/shipments/${shipmentId}/label/file`).expect(200);
        await bob.get(`/shipments/${shipmentId}/label/file`).expect(404);
      });

      it('keeps one organization’s shipments from another', async () => {
        expect((await bob.get('/shipments').expect(200)).body.data).toEqual([]);
        await bob.get(`/shipments/${shipmentId}`).expect(404);
        await bob.get(`/orders/${order.id}/shipments`).expect(404);
        await bob.post(`/shipments/${shipmentId}/refresh`).expect(404);
        await bob.post(`/shipments/${shipmentId}/cancel`).expect(404);
        await bob.post(`/shipments/${shipmentId}/retry`).expect(404);
        await bob.get(`/shipments/${shipmentId}/label`).expect(404);
        await bob
          .post(`/orders/${order.id}/shipments`, { providerCode: 'shiprocket' })
          .expect(404);
      });

      it('shows the carrier’s outage as 503 with a saved shipment to retry', async () => {
        const o = await place();
        sr.failCreate.push({ networkError: true });
        const res = await alice
          .post(`/orders/${o.id}/shipments`, { providerCode: 'shiprocket' })
          .expect(503);
        expect(res.body.error.code).toBe('SHIPMENT_PENDING');
        const id = res.body.error.details.shipmentId as string;
        expect(
          (await alice.get(`/shipments/${id}`).expect(200)).body.data.status,
        ).toBe('creating');
        expect(
          (await alice.post(`/shipments/${id}/retry`).expect(200)).body.data
            .status,
        ).toBe('created');
        await alice.post(`/shipments/${id}/retry`).expect(409);
      });
    });

    describe('carrier webhook', () => {
      it('is public, answers 200 whatever it is sent, and only ever triggers a lookup', async () => {
        const o = await place();
        const sh = (
          await alice
            .post(`/orders/${o.id}/shipments`, { providerCode: 'shiprocket' })
            .expect(201)
        ).body.data;
        sr.say(sh.awb, 'In Transit');
        await t.db.asOwner((pg) =>
          pg.query(
            `update shipments set last_synced_at = now() - interval '1 hour' where id = $1`,
            [sh.id],
          ),
        );
        const url = api('/webhooks/carriers/shiprocket');
        await anon()
          .post(url)
          .send({ awb: sh.awb, current_status: 'DELIVERED' })
          .expect(200);
        expect(
          (await alice.get(`/shipments/${sh.id}`).expect(200)).body.data.status,
        ).toBe('in_transit');
        await anon().post(url).send({ awb: 'NOSUCHAWB123' }).expect(200);
        await anon().post(url).send({}).expect(200);
        await anon().post(url).send([1, 2, 3]).expect(200);
        await anon()
          .post(url)
          .set('Content-Type', 'application/json')
          .send('{"not":"closed"')
          .expect(200);
        await anon().post(url).type('form').send({ awb: sh.awb }).expect(200);
        await anon()
          .post(api('/webhooks/carriers/nosuchcarrier'))
          .send({ awb: sh.awb })
          .expect(404);
      });
    });

    describe('the tracking job', () => {
      it('refuses calls without the cron secret', async () => {
        await anon().get(api('/internal/jobs/sync-shipments')).expect(401);
        await anon()
          .get(api('/internal/jobs/sync-shipments'))
          .set('Authorization', 'Bearer wrong-secret-wrong-secret-wrong-secret')
          .expect(401);
      });

      it('runs with the right secret, reports what it did, and is not in the public docs', async () => {
        await t.db.asOwner((pg) =>
          pg.query(
            `update shipments set last_synced_at = now() - interval '2 hours' where status = 'created'`,
          ),
        );
        const res = await anon()
          .get(api('/internal/jobs/sync-shipments'))
          .set('Authorization', `Bearer ${CRON_SECRET}`)
          .expect(200);
        expect(res.body.data).toEqual({
          tenants: expect.any(Number),
          shipments: expect.any(Number),
          updated: expect.any(Number),
          failed: 0,
        });
        const doc = (await anon().get('/api/docs-json')).body as {
          paths?: Record<string, unknown>;
        };
        expect(
          Object.keys(doc.paths ?? {}).some((p) => p.includes('/internal/')),
        ).toBe(false);
      });
    });
  },
);
