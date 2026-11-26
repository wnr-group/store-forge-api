import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const KEY_SECRET = 'Zk3Fq9Lm2Xv8Bn4Jt7Hs1Pw6';
const WEBHOOK_SECRET = 'whsec-http-test-value-1';
const NO_ORDER = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!migrationsAvailable)(
  'payment settings and shopper payment routes (HTTP e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let writer: Awaited<ReturnType<typeof as>>;
    let aliceNoOrg: Awaited<ReturnType<typeof as>>;
    const pub = () => request(t.app.getHttpServer());

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      // Belt and braces: even if a test reached the Razorpay client, nothing could leave this machine.
      process.env.RAZORPAY_API_BASE_URL = 'https://127.0.0.1:9';
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner((pg) =>
        pg.query(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1, 'Mug', 'http-mug', 25000, 5, 'active')`,
          [w.tenantA],
        ),
      );
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      writer = await as(t, w.members.writer, w.tenantA);
      aliceNoOrg = await as(t, w.alice);
    });
    afterAll(async () => {
      delete process.env.RAZORPAY_API_BASE_URL;
      await t?.close();
      await t?.db.close();
    });

    describe('owner settings routes', () => {
      it('require the organization header', async () => {
        for (const res of [
          await aliceNoOrg.get('/payments/cod'),
          await aliceNoOrg.put('/payments/cod', {
            enabled: false,
            minOrderMinor: 0,
            feeMinor: 0,
          }),
          await aliceNoOrg.post('/payments/razorpay/verify'),
          await aliceNoOrg.put('/payments/razorpay/enabled', {
            enabled: false,
          }),
        ]) {
          expect(res.status).toBe(400);
          expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
        }
      });

      it('are closed to anyone who is not signed in', async () => {
        await pub().get('/api/v1/payments/cod').expect(401);
        await pub().post('/api/v1/payments/razorpay/verify').expect(401);
      });

      it('are Owner only, even for a member who can edit store settings', async () => {
        await writer.get('/payments/cod').expect(403);
        await writer
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 0,
            feeMinor: 0,
          })
          .expect(403);
        await writer.post('/payments/razorpay/verify').expect(403);
        await writer
          .put('/payments/razorpay/enabled', { enabled: true })
          .expect(403);
      });

      it('save and read the COD settings, and validate them', async () => {
        expect(
          (await alice.get('/payments/cod').expect(200)).body.data,
        ).toMatchObject({ configured: false, enabled: false });
        const saved = await alice
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 10000,
            maxOrderMinor: 500000,
            feeMinor: 4000,
          })
          .expect(200);
        expect(saved.body.data).toMatchObject({
          configured: true,
          enabled: true,
          minOrderMinor: 10000,
          maxOrderMinor: 500000,
          feeMinor: 4000,
        });
        expect(
          (await alice.get('/payments/cod').expect(200)).body.data.feeMinor,
        ).toBe(4000);

        await alice
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: -1,
            feeMinor: 0,
          })
          .expect(400);
        await alice
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 500,
            feeMinor: 1.5,
          })
          .expect(400);
        await alice
          .put('/payments/cod', {
            enabled: 'yes',
            minOrderMinor: 0,
            feeMinor: 0,
          })
          .expect(400);
        await alice
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 5000,
            maxOrderMinor: 100,
            feeMinor: 0,
          })
          .expect(400);
        await alice
          .put('/payments/cod', {
            enabled: true,
            minOrderMinor: 0,
            feeMinor: 0,
            tenantId: w.tenantB,
          })
          .expect(400);
      });

      it("keep one organization's COD settings away from another", async () => {
        expect(
          (await bob.get('/payments/cod').expect(200)).body.data.configured,
        ).toBe(false);
      });

      it('refuse to turn Razorpay on before the keys were checked, and to check keys that were never saved', async () => {
        await bob.post('/payments/razorpay/verify').expect(404);
        await bob
          .put('/payments/razorpay/enabled', { enabled: true })
          .expect(404);

        await alice
          .put('/payments/razorpay', {
            keyId: 'rzp_test_AbCdEfGh12345678',
            keySecret: KEY_SECRET,
            webhookSecret: WEBHOOK_SECRET,
          })
          .expect(200);
        const early = await alice
          .put('/payments/razorpay/enabled', { enabled: true })
          .expect(409);
        expect(early.body.error.code).toBe('RAZORPAY_NOT_VERIFIED');
        await alice
          .put('/payments/razorpay/enabled', { enabled: 'maybe' })
          .expect(400);
      });

      it('show the connection state and never any secret', async () => {
        const status = (await alice.get('/payments/razorpay').expect(200)).body
          .data;
        expect(status).toMatchObject({
          configured: true,
          enabled: false,
          verificationStatus: 'unverified',
          webhookSecretConfigured: true,
        });
        const text = JSON.stringify(status);
        for (const secret of [
          KEY_SECRET,
          WEBHOOK_SECRET,
          'ciphertext',
          'auth_tag',
        ])
          expect(text).not.toContain(secret);
      });
    });

    describe('shopper payment routes', () => {
      it('list what the store offers, from its own settings', async () => {
        const ok = await pub()
          .get(
            '/api/v1/public/stores/alpha-shop/payment-methods?subtotalMinor=50000',
          )
          .expect(200);
        expect(ok.body.data).toEqual({
          razorpayAvailable: false,
          codAvailable: true,
          codFeeMinor: 4000,
          codUnavailableReason: null,
        });
        const tooSmall = await pub()
          .get(
            '/api/v1/public/stores/alpha-shop/payment-methods?subtotalMinor=100',
          )
          .expect(200);
        expect(tooSmall.body.data).toMatchObject({
          codAvailable: false,
          codUnavailableReason: expect.stringMatching(/minimum/),
        });
        const other = await pub()
          .get(
            '/api/v1/public/stores/beta-shop/payment-methods?subtotalMinor=50000',
          )
          .expect(200);
        expect(other.body.data).toMatchObject({
          razorpayAvailable: false,
          codAvailable: false,
        });
      });

      it('reject a bad order value and an unknown store', async () => {
        await pub()
          .get(
            '/api/v1/public/stores/alpha-shop/payment-methods?subtotalMinor=abc',
          )
          .expect(400);
        await pub()
          .get(
            '/api/v1/public/stores/alpha-shop/payment-methods?subtotalMinor=-5',
          )
          .expect(400);
        await pub()
          .get('/api/v1/public/stores/ghost-store/payment-methods')
          .expect(404);
      });

      it('answer 404 without a valid order token, whichever payment step is asked for', async () => {
        const base =
          '/api/v1/public/stores/alpha-shop/orders/1/payments/razorpay';
        const details = {
          razorpay_order_id: 'order_Abc12345678',
          razorpay_payment_id: 'pay_Abc12345678',
        };
        await pub().post(base).expect(404);
        await pub()
          .post(`${base}/verify`)
          .send({ ...details, razorpay_signature: 'a'.repeat(64) })
          .expect(404);
        await pub().post(`${base}/failed`).send(details).expect(404);
      });

      it('validate the confirmation body without echoing it', async () => {
        const res = await pub()
          .post(
            '/api/v1/public/stores/alpha-shop/orders/1/payments/razorpay/verify',
          )
          .set('X-Order-Token', 'x')
          .send({
            razorpay_order_id: "'; drop table--",
            razorpay_payment_id: 'pay_Abc12345678',
            razorpay_signature: 'short',
          })
          .expect(400);
        expect(JSON.stringify(res.body)).not.toContain('drop table');
        await pub()
          .post('/api/v1/public/stores/alpha-shop/orders/abc/payments/razorpay')
          .expect(400);
      });
    });

    describe('collecting cash on delivery', () => {
      it('needs the orders write level', async () => {
        const reader = await as(t, w.members.reader, w.tenantA);
        await reader.post(`/orders/${NO_ORDER}/cod/collect`).expect(403);
        await pub().post(`/api/v1/orders/${NO_ORDER}/cod/collect`).expect(401);
      });

      it('answers 404 for an order that is not in your organization', async () => {
        await alice.post(`/orders/${NO_ORDER}/cod/collect`).expect(404);
        await alice.post('/orders/not-a-uuid/cod/collect').expect(400);
      });
    });
  },
);
