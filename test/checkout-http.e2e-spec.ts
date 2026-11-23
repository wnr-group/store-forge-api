import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef-xyz';
const validOrder = {
  lines: [{ productSlug: 'http-mug', quantity: 1 }],
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
};

describe.skipIf(!migrationsAvailable)('checkout HTTP routes (e2e)', () => {
  let t: TestApp;
  let w: World;
  let bearer: Awaited<ReturnType<typeof as>>;
  const post = (path: string) =>
    request(t.app.getHttpServer()).post(`/api/v1${path}`);
  const get = (path: string) =>
    request(t.app.getHttpServer()).get(`/api/v1${path}`);

  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    const db = await createTestDb();
    w = await seedWorld(db);
    await db.asOwner((pg) =>
      pg.query(
        `insert into products (tenant_id, name, slug, price_minor, quantity, status)
         values ($1, 'Mug', 'http-mug', 25000, 5, 'active')`,
        [w.tenantA],
      ),
    );
    t = await createTestApp(db);
    bearer = await as(t, w.alice);
  });
  afterAll(async () => {
    delete process.env.CRON_SECRET;
    await t?.close();
    await t?.db.close();
  });

  it('needs no sign-in, but refuses an order without an Idempotency-Key', async () => {
    const res = await post('/public/stores/alpha-shop/orders')
      .send(validOrder)
      .expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('validates the body field by field and never echoes what was typed', async () => {
    const bad = {
      ...validOrder,
      customer: { fullName: 'A', email: 'not-an-email', phone: '12345' },
      shippingAddress: {
        ...validOrder.shippingAddress,
        postalCode: '12',
        state: 'Atlantis-SECRET',
      },
      paymentMethod: 'paypal',
      lines: [{ productSlug: 'http-mug', quantity: 0 }],
      surprise: true,
    };
    const res = await post('/public/stores/alpha-shop/orders')
      .set('Idempotency-Key', 'http-key-000001')
      .send(bad)
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('Atlantis-SECRET');
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  it('refuses to take an order until the store has a payment method set up', async () => {
    const res = await post('/public/stores/alpha-shop/orders')
      .set('Idempotency-Key', 'http-key-000002')
      .send(validOrder)
      .expect(409);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
  });

  it('answers 404 for an unknown store and for an unknown order', async () => {
    await post('/public/stores/ghost-store/orders')
      .set('Idempotency-Key', 'http-key-000003')
      .send(validOrder)
      .expect(404);
    await get('/public/stores/alpha-shop/orders/1')
      .set('X-Order-Token', 'x')
      .expect(404);
  });

  it('requires a numeric order number', async () => {
    await get('/public/stores/alpha-shop/orders/abc').expect(400);
  });

  describe('dashboard orders', () => {
    it('is closed to people who are not signed in and to members without the orders module', async () => {
      await get('/orders').expect(401);
      const nothing = await as(t, w.members.nothing);
      await nothing.get('/orders').expect(403);
    });

    it('lets the Owner read orders; a reader-level member can look but not change them', async () => {
      await bearer.get('/orders').expect(200);
      const reader = await as(t, w.members.reader);
      await reader.get('/orders').expect(200);
      await reader
        .post('/orders/00000000-0000-4000-8000-000000000000/status', {
          status: 'processing',
        })
        .expect(403);
      await reader
        .post('/orders/00000000-0000-4000-8000-000000000000/cancel', {
          reason: 'x',
        })
        .expect(403);
    });

    it('rejects a malformed order id and an unknown status value', async () => {
      await bearer.get('/orders/not-a-uuid').expect(400);
      await bearer
        .post('/orders/00000000-0000-4000-8000-000000000000/status', {
          status: 'teleported',
        })
        .expect(400);
    });

    it('keeps one organization out of another one’s orders', async () => {
      await t.db.asOwner((pg) =>
        pg.query(
          `insert into orders (tenant_id, order_number, currency, subtotal_minor, total_minor)
           values ($1, 7001, 'INR', 100, 100)`,
          [w.tenantB],
        ),
      );
      const mine = await bearer.get('/orders?search=7001').expect(200);
      expect(mine.body.data).toEqual([]);
    });
  });

  describe('scheduler endpoint', () => {
    it('refuses calls without the right secret', async () => {
      await get('/internal/jobs/expire-reservations').expect(401);
      await get('/internal/jobs/expire-reservations')
        .set('Authorization', 'Bearer wrong-secret-wrong-secret-wrong-secret')
        .expect(401);
    });

    it('runs the expiry job with the right secret and is not in the public API docs', async () => {
      const res = await get('/internal/jobs/expire-reservations')
        .set('Authorization', `Bearer ${CRON_SECRET}`)
        .expect(200);
      expect(res.body.data).toMatchObject({ failedTenants: 0 });
      const doc = (await get('/docs-json')).body as {
        paths?: Record<string, unknown>;
      };
      expect(
        Object.keys(doc.paths ?? {}).some((p) => p.includes('/internal/')),
      ).toBe(false);
    });
  });
});
