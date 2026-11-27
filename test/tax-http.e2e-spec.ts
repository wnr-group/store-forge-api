import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gstinCheckChar } from '../src/modules/tax/gst.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { registerShopper } from './support/shopper.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const KA = '29AABCT1332L1Z';
const GSTIN = KA + gstinCheckChar(KA);
const NO_ID = '00000000-0000-4000-8000-000000000000';
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  gstin: GSTIN,
  legalName: 'Alpha Traders',
  pricesIncludeTax: false,
  defaultRateBps: 1800,
  chargesTaxable: true,
  chargesRateBps: 1800,
  ...over,
});

describe.skipIf(!migrationsAvailable)(
  'GST over HTTP: settings, report, product rates and the public quote',
  () => {
    let t: TestApp;
    const shopper: Record<string, string> = {};
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let writer: Awaited<ReturnType<typeof as>>;
    let nobody: Awaited<ReturnType<typeof as>>;
    let noOrg: Awaited<ReturnType<typeof as>>;
    let methodId = '';
    const anon = () => request(t.app.getHttpServer());
    const api = (p: string) => `/api/v1${p}`;
    const address = (over: Record<string, string> = {}) => ({
      state: 'Karnataka',
      city: 'Bengaluru',
      postalCode: '560001',
      ...over,
    });
    const quote = (body: object) =>
      anon().post(api('/public/stores/alpha-shop/checkout/quote')).send(body);
    const order = (
      extra: object = {},
      to: Record<string, string> = {},
      key = randomBytes(12).toString('hex'),
    ) =>
      anon()
        .post(api('/public/stores/alpha-shop/orders'))
        .set('X-Customer-Session', shopper['alpha-shop'])
        .set('Idempotency-Key', key)
        .send({
          lines: [{ productSlug: 'tax-mug', quantity: 2 }],
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
            ...to,
          },
          paymentMethod: 'cod',
          ...extra,
        });

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) =>
        pg.query(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status, weight_grams) values ($1, 'Mug', 'tax-mug', 50000, 500, 'active', 400)`,
          [w.tenantA],
        ),
      );
      t = await createTestApp(db);
      shopper['alpha-shop'] = await registerShopper(t.app, 'alpha-shop');
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      writer = await as(t, w.members.writer, w.tenantA);
      nobody = await as(t, w.members.nothing, w.tenantA);
      noOrg = await as(t, w.alice);
      await alice
        .put('/payments/cod', {
          enabled: true,
          minOrderMinor: 0,
          feeMinor: 3000,
        })
        .expect(200);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('access', () => {
      it('needs the organization header and a signed-in user', async () => {
        for (const call of [
          () => noOrg.get('/tax/settings'),
          () => noOrg.put('/tax/settings', settings()),
          () => noOrg.get('/tax/report'),
        ]) {
          const res = await call();
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        }
        await anon().get(api('/tax/settings')).expect(401);
        await anon().put(api('/tax/settings')).send(settings()).expect(401);
        await anon().get(api('/tax/report')).expect(401);
      });

      it('lets store-settings readers look, writers change, and keeps the report with orders access', async () => {
        await reader.get('/tax/settings').expect(200);
        await reader.put('/tax/settings', settings()).expect(403);
        await writer
          .put('/tax/settings', settings({ defaultRateBps: 1800 }))
          .expect(200);
        await reader.get('/tax/report').expect(200);
        await nobody.get('/tax/settings').expect(200);
        await nobody.put('/tax/settings', settings()).expect(403);
        await nobody.get('/tax/report').expect(403);
      });
    });

    describe('settings', () => {
      it('validate the request and say what is wrong', async () => {
        await alice.put('/tax/settings', {}).expect(400);
        await alice
          .put('/tax/settings', settings({ defaultRateBps: 1500 }))
          .expect(400);
        await alice
          .put('/tax/settings', settings({ chargesRateBps: 'high' }))
          .expect(400);
        await alice
          .put('/tax/settings', settings({ enabled: 'yes' }))
          .expect(400);
        await alice
          .put('/tax/settings', settings({ gstin: 'X'.repeat(40) }))
          .expect(400);
        await alice
          .put('/tax/settings', settings({ tenantId: w.tenantB }))
          .expect(400);
        const wrong = GSTIN.slice(0, 14) + (GSTIN.endsWith('A') ? 'B' : 'A');
        const bad = await alice
          .put('/tax/settings', settings({ gstin: wrong }))
          .expect(400);
        expect(bad.body.error).toMatchObject({
          code: 'TAX_SETTINGS_INVALID',
          details: { gstin: expect.stringMatching(/not a valid GSTIN/) },
        });
        const none = await alice
          .put('/tax/settings', settings({ gstin: null }))
          .expect(400);
        expect(none.body.error.details.gstin).toBe(
          'Enter your GSTIN to charge GST.',
        );
      });

      it('save, read back, and are private to each organization', async () => {
        expect(
          (await alice.get('/tax/settings').expect(200)).body.data.configured,
        ).toBe(true);
        const saved = (
          await alice
            .put('/tax/settings', settings({ gstin: GSTIN.toLowerCase() }))
            .expect(200)
        ).body.data;
        expect(saved).toMatchObject({
          enabled: true,
          gstin: GSTIN,
          stateCode: '29',
          stateName: 'Karnataka',
          defaultRateBps: 1800,
        });
        expect(
          (await bob.get('/tax/settings').expect(200)).body.data,
        ).toMatchObject({ configured: false, enabled: false });
      });
    });

    describe('product tax fields', () => {
      it('are saved, kept when not mentioned, cleared with null, and validated', async () => {
        const created = (
          await alice
            .post('/products', {
              name: 'Taxed',
              price: '100',
              taxRateBps: 500,
              hsnCode: '6109',
            })
            .expect(201)
        ).body.data;
        expect(created).toMatchObject({ taxRateBps: 500, hsnCode: '6109' });
        const plain = (
          await alice
            .post('/products', { name: 'Plain', price: '100' })
            .expect(201)
        ).body.data;
        expect(plain).toMatchObject({ taxRateBps: null, hsnCode: null });
        const kept = (
          await alice
            .patch(`/products/${created.id}`, { name: 'Taxed 2' })
            .expect(200)
        ).body.data;
        expect(kept).toMatchObject({ taxRateBps: 500, hsnCode: '6109' });
        const changed = (
          await alice
            .patch(`/products/${created.id}`, {
              taxRateBps: 1200,
              hsnCode: '61091000',
            })
            .expect(200)
        ).body.data;
        expect(changed).toMatchObject({
          taxRateBps: 1200,
          hsnCode: '61091000',
        });
        const cleared = (
          await alice
            .patch(`/products/${created.id}`, {
              taxRateBps: null,
              hsnCode: null,
            })
            .expect(200)
        ).body.data;
        expect(cleared).toMatchObject({ taxRateBps: null, hsnCode: null });
        await alice
          .patch(`/products/${created.id}`, { taxRateBps: 1500 })
          .expect(400);
        await alice
          .patch(`/products/${created.id}`, { taxRateBps: 'x' })
          .expect(400);
        await alice
          .patch(`/products/${created.id}`, { hsnCode: 'abc' })
          .expect(400);
        await alice
          .patch(`/products/${created.id}`, { hsnCode: '12345' })
          .expect(400);
        await alice
          .post('/products', { name: 'Bad', price: '1', taxRateBps: 7 })
          .expect(400);
        const zero = (
          await alice
            .patch(`/products/${created.id}`, { taxRateBps: 0 })
            .expect(200)
        ).body.data;
        expect(zero.taxRateBps).toBe(0); // zero-rated is a real rate, not "unset"
        const copy = (
          await alice.post(`/products/${created.id}/duplicate`).expect(201)
        ).body.data;
        expect(copy).toMatchObject({ taxRateBps: 0 });
      });
    });

    describe('the public quote', () => {
      const lines = [{ productSlug: 'tax-mug', quantity: 2 }];

      it('prices a cart exactly as the order is then priced', async () => {
        const q = (
          await quote({
            address: address(),
            lines,
            paymentMethod: 'cod',
          }).expect(200)
        ).body.data;
        // 2 x 500.00 = 1000.00 + COD charge 30.00; GST 18% of 1030.00 = 185.40 (92.70 CGST + 92.70 SGST)
        expect(q).toMatchObject({
          subtotalMinor: 100000,
          shippingMinor: 0,
          codFeeMinor: 3000,
          taxMinor: 18540,
          taxInclusive: false,
          totalMinor: 121540,
        });
        expect(q.tax).toMatchObject({
          regime: 'intra',
          cgstMinor: 9270,
          sgstMinor: 9270,
          igstMinor: 0,
          sellerGstin: GSTIN,
        });
        const placed = (await order().expect(201)).body.data;
        expect(placed).toMatchObject({
          subtotalMinor: q.subtotalMinor,
          codFeeMinor: q.codFeeMinor,
          taxMinor: q.taxMinor,
          totalMinor: q.totalMinor,
        });
        expect(placed.tax).toEqual(q.tax);
      });

      it('charges IGST for another state, and nothing without a payment method that has a charge', async () => {
        const inter = (
          await quote({
            address: address({
              state: 'Maharashtra',
              postalCode: '400001',
              city: 'Mumbai',
            }),
            lines,
            paymentMethod: 'cod',
          }).expect(200)
        ).body.data;
        expect(inter.tax).toMatchObject({
          regime: 'inter',
          igstMinor: 18540,
          cgstMinor: 0,
        });
        const online = (await quote({ address: address(), lines }).expect(200))
          .body.data;
        expect(online).toMatchObject({
          codFeeMinor: 0,
          taxMinor: 18000,
          totalMinor: 118000,
        });
      });

      it('includes the delivery charge and its tax once a delivery option is chosen, and the order matches', async () => {
        const zone = (
          await alice
            .post('/shipping/zones', {
              name: 'India',
              areas: { country: true },
            })
            .expect(201)
        ).body.data;
        const method = (
          await alice
            .post('/shipping/methods', {
              zoneId: zone.id,
              name: 'Standard',
              pricingType: 'flat',
              flatRateMinor: 5000,
            })
            .expect(201)
        ).body.data;
        methodId = method.id;
        const q = (
          await quote({
            address: address(),
            lines,
            paymentMethod: 'cod',
            shippingMethodId: method.id,
          }).expect(200)
        ).body.data;
        // items 1000.00 + delivery 50.00 + COD 30.00 = 1080.00; GST 194.40
        expect(q).toMatchObject({
          shippingMinor: 5000,
          codFeeMinor: 3000,
          taxMinor: 19440,
          totalMinor: 108000 + 19440,
        });
        expect(q.tax.lines.map((l: { kind: string }) => l.kind)).toEqual([
          'item',
          'shipping',
          'cod_fee',
        ]);
        const placed = (
          await order({ shippingMethodId: method.id }).expect(201)
        ).body.data;
        expect(placed).toMatchObject({
          shippingMinor: 5000,
          taxMinor: q.taxMinor,
          totalMinor: q.totalMinor,
        });
        // Without the option the delivery charge is simply not part of the quote.
        expect(
          (
            await quote({
              address: address(),
              lines,
              paymentMethod: 'cod',
            }).expect(200)
          ).body.data.shippingMinor,
        ).toBe(0);
        await quote({
          address: address(),
          lines,
          shippingMethodId: NO_ID,
        }).expect(409);
      });

      it('is shown to the shopper and the Owner on the order', async () => {
        const placed = (await order({ shippingMethodId: methodId }).expect(201))
          .body.data;
        const view = (
          await anon()
            .get(api(`/public/stores/alpha-shop/orders/${placed.orderNumber}`))
            .set('X-Order-Token', placed.accessToken)
            .expect(200)
        ).body.data;
        expect(view.tax).toEqual(placed.tax);
        const list = (
          await alice.get(`/orders?search=${placed.orderNumber}`).expect(200)
        ).body.data;
        const detail = (await alice.get(`/orders/${list[0].id}`).expect(200))
          .body.data;
        expect(detail.tax).toEqual(placed.tax);
        expect(detail.taxMinor).toBe(placed.taxMinor);
        // Another organization sees none of it.
        await bob.get(`/orders/${list[0].id}`).expect(404);
      });

      it('validates the request and reports cart problems like placing an order', async () => {
        await quote({ lines }).expect(400);
        await quote({ address: address() }).expect(400);
        await quote({ address: address(), lines: [] }).expect(400);
        await quote({ address: address({ state: 'Atlantis' }), lines }).expect(
          400,
        );
        await quote({
          address: address(),
          lines,
          shippingMethodId: 'nope',
        }).expect(400);
        await quote({ address: address(), lines, price: 1 }).expect(400);
        expect(
          (
            await quote({
              address: address(),
              lines: [{ productSlug: 'no-such-thing', quantity: 1 }],
            }).expect(409)
          ).body.error.code,
        ).toBe('CHECKOUT_ISSUES');
        await anon()
          .post(api('/public/stores/ghost-store/checkout/quote'))
          .send({ address: address(), lines })
          .expect(404);
      });
    });

    describe('the report', () => {
      it('totals GST by rate, reads dates, and is private to each organization', async () => {
        const r = (await alice.get('/tax/report').expect(200)).body.data;
        expect(r.taxedOrders).toBeGreaterThan(0);
        expect(r.totals.taxMinor).toBe(
          r.totals.cgstMinor + r.totals.sgstMinor + r.totals.igstMinor,
        );
        expect(r.byRate[0].rateBps).toBe(1800);
        expect(r.chargesTaxMinor).toBeGreaterThan(0);
        const today = new Date().toISOString().slice(0, 10);
        expect(
          (await alice.get(`/tax/report?from=${today}&to=${today}`).expect(200))
            .body.data.from,
        ).toBe(today);
        await alice.get('/tax/report?from=yesterday').expect(400);
        await alice
          .get('/tax/report?from=2026-05-01&to=2026-04-01')
          .expect(400);
        expect(
          (await bob.get('/tax/report').expect(200)).body.data.totals.taxMinor,
        ).toBe(0);
      });
    });
  },
);
