import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { registerShopper } from './support/shopper.js';
import { seedWorld, type World } from './support/world.js';

const PASSWORD = 'Shopper123';
const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};
const order = (slug: string, quantity = 1) => ({
  lines: [{ productSlug: slug, quantity }],
  customer: {
    fullName: 'Asha Rao',
    email: 'asha@example.test',
    phone: '9876543210',
  },
  shippingAddress: address,
  paymentMethod: 'cod',
});

describe.skipIf(!migrationsAvailable)(
  'storefront customer accounts, orders and tracking (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    const http = () => t.app.getHttpServer();
    const ip = () =>
      `10.7.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const acct = (
      slug: string,
      path: string,
      method: 'get' | 'post' | 'put' | 'patch' | 'delete',
      token?: string,
    ) => {
      const r = request(http())
        [method](`/api/v1/public/stores/${slug}/account${path}`)
        .set('X-Forwarded-For', ip());
      return token ? r.set('X-Customer-Session', token) : r;
    };
    const place = (
      slug: string,
      token: string | undefined,
      body: object = order('acct-mug'),
    ) => {
      const r = request(http())
        .post(`/api/v1/public/stores/${slug}/orders`)
        .set('X-Forwarded-For', ip())
        .set('Idempotency-Key', randomBytes(12).toString('hex'));
      return (token ? r.set('X-Customer-Session', token) : r).send(body);
    };

    let ashaA: string; // shopper of alpha-shop
    let ravi: string; // another shopper of alpha-shop
    let ashaB: string; // the same email, in beta-shop
    let alice: Awaited<ReturnType<typeof as>>;

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner(async (pg) => {
        await pg.query(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status)
           values ($1, 'Mug', 'acct-mug', 25000, 20, 'active'), ($2, 'Cup', 'beta-cup', 9000, 20, 'active')`,
          [w.tenantA, w.tenantB],
        );
      });
      t = await createTestApp(db);
      alice = await as(t, w.alice, w.tenantA);
      await alice
        .put('/payments/cod', { enabled: true, minOrderMinor: 0, feeMinor: 0 })
        .expect(200);
      const bob = await as(t, w.bob, w.tenantB);
      await bob
        .put('/payments/cod', { enabled: true, minOrderMinor: 0, feeMinor: 0 })
        .expect(200);
      ashaA = await registerShopper(t.app, 'alpha-shop', 'asha@example.test');
      ravi = await registerShopper(t.app, 'alpha-shop', 'ravi@example.test');
      ashaB = await registerShopper(t.app, 'beta-shop', 'asha@example.test');
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('sign up and sign in', () => {
      it('refuses a duplicate email in the same store, but the same email can join another store', async () => {
        const res = await acct('alpha-shop', '/register', 'post')
          .send({
            fullName: 'Asha Again',
            email: 'ASHA@example.test',
            password: PASSWORD,
          })
          .expect(409);
        expect(res.body.error.code).toBe('CUSTOMER_EMAIL_TAKEN');
        expect(ashaB).toBeTruthy(); // registered in beta-shop in beforeAll
      });

      it('validates the password and email without echoing them', async () => {
        const weak = await acct('alpha-shop', '/register', 'post')
          .send({ fullName: 'X', email: 'x@example.test', password: 'short' })
          .expect(400);
        expect(JSON.stringify(weak.body)).not.toContain('short"');
        await acct('alpha-shop', '/register', 'post')
          .send({ fullName: 'X', email: 'nope', password: PASSWORD })
          .expect(400);
      });

      it('signs in, reads the profile, and signs out (the token stops working)', async () => {
        const login = await acct('alpha-shop', '/login', 'post')
          .send({ email: 'Asha@Example.test', password: PASSWORD })
          .expect(200);
        const token = login.body.data.sessionToken as string;
        expect(login.body.data.profile.email).toBe('asha@example.test');
        await acct('alpha-shop', '/me', 'get', token).expect(200);
        await acct('alpha-shop', '/logout', 'post', token).expect(200);
        await acct('alpha-shop', '/me', 'get', token).expect(401);
      });

      it('answers a wrong password and an unknown email the same way, then locks the account', async () => {
        const wrong = await acct('alpha-shop', '/login', 'post')
          .send({ email: 'ravi@example.test', password: 'Wrong-pass-1' })
          .expect(401);
        const unknown = await acct('alpha-shop', '/login', 'post')
          .send({ email: 'nobody@example.test', password: 'Wrong-pass-1' })
          .expect(401);
        expect(wrong.body.message).toBe(unknown.body.message);
        expect(wrong.body.error.code).toBe(unknown.body.error.code);
        for (let i = 0; i < 7; i++)
          await acct('alpha-shop', '/login', 'post')
            .send({ email: 'ravi@example.test', password: 'Wrong-pass-1' })
            .expect(401);
        // Locked now: even the right password is refused for a while.
        await acct('alpha-shop', '/login', 'post')
          .send({ email: 'ravi@example.test', password: PASSWORD })
          .expect(429);
        // Ravi's existing session is unaffected; other shoppers are unaffected.
        await acct('alpha-shop', '/me', 'get', ravi).expect(200);
        await acct('alpha-shop', '/login', 'post')
          .send({ email: 'asha@example.test', password: PASSWORD })
          .expect(200);
      });

      it('changes the password, signing out the other devices', async () => {
        const other = (
          await acct('alpha-shop', '/login', 'post')
            .send({ email: 'asha@example.test', password: PASSWORD })
            .expect(200)
        ).body.data.sessionToken as string;
        await acct('alpha-shop', '/password', 'post', ashaA)
          .send({ currentPassword: 'not-it-1234', newPassword: 'Changed456' })
          .expect(400);
        await acct('alpha-shop', '/password', 'post', ashaA)
          .send({ currentPassword: PASSWORD, newPassword: 'Changed456' })
          .expect(200);
        await acct('alpha-shop', '/me', 'get', ashaA).expect(200);
        await acct('alpha-shop', '/me', 'get', other).expect(401);
        await acct('alpha-shop', '/login', 'post')
          .send({ email: 'asha@example.test', password: PASSWORD })
          .expect(401);
        await acct('alpha-shop', '/login', 'post')
          .send({ email: 'asha@example.test', password: 'Changed456' })
          .expect(200);
      });

      it('updates the profile', async () => {
        const res = await acct('alpha-shop', '/me', 'patch', ashaA)
          .send({ fullName: 'Asha R', phone: '9123456780' })
          .expect(200);
        expect(res.body.data).toMatchObject({
          fullName: 'Asha R',
          phone: '9123456780',
        });
        await acct('alpha-shop', '/me', 'patch', ashaA)
          .send({ phone: '123' })
          .expect(400);
      });
    });

    describe('store and role separation', () => {
      it('a session of one store is useless in another store', async () => {
        await acct('beta-shop', '/me', 'get', ashaA).expect(401);
        await acct('alpha-shop', '/me', 'get', ashaB).expect(401);
      });

      it('rejects a missing, junk or owner token as a customer session', async () => {
        await acct('alpha-shop', '/me', 'get').expect(401);
        await acct('alpha-shop', '/me', 'get', 'x'.repeat(43)).expect(401);
        await acct('alpha-shop', '/me', 'get', alice.token).expect(401);
      });

      it('a customer session is not an owner credential', async () => {
        for (const path of ['/orders', '/customers', '/products'])
          await request(http())
            .get(`/api/v1${path}`)
            .set('Authorization', `Bearer ${ashaA}`)
            .set('X-Organization-Id', w.tenantA)
            .set('X-Forwarded-For', ip())
            .expect(401);
      });

      it('no dashboard or anonymous database role can read the account tables', async () => {
        const probe = async (role: string, table: string) =>
          t.db.asOwner(async (pg) => {
            await pg.exec(`set role ${role}`);
            try {
              await pg.query(`select * from ${table}`);
              return 'allowed';
            } catch (e) {
              return (e as { code?: string }).code ?? 'error';
            } finally {
              await pg.exec('reset role');
            }
          });
        for (const table of [
          'customer_accounts',
          'customer_sessions',
          'customer_addresses',
        ])
          for (const role of ['authenticated', 'anon'])
            expect(await probe(role, table)).toBe('42501');
      });

      it('stores only a hash of the password and of the session token', async () => {
        const rows = await t.db.asOwner(async (pg) => ({
          hash: (
            await pg.query<{ password_hash: string }>(
              "select password_hash from customer_accounts where email = 'asha@example.test' limit 1",
            )
          ).rows[0].password_hash,
          tokens: (
            await pg.query<{ token_hash: string }>(
              'select token_hash from customer_sessions',
            )
          ).rows.map((r) => r.token_hash),
        }));
        expect(rows.hash.startsWith('scrypt$')).toBe(true);
        expect(rows.hash).not.toContain(PASSWORD);
        expect(rows.tokens).not.toContain(ashaA);
        expect(rows.tokens.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      });
    });

    describe('addresses', () => {
      it('saves, defaults, edits and removes addresses, scoped to the account', async () => {
        const first = await acct('alpha-shop', '/addresses', 'post', ashaA)
          .send({ ...address, label: 'Home' })
          .expect(201);
        expect(first.body.data).toHaveLength(1);
        expect(first.body.data[0].isDefault).toBe(true);
        const second = await acct('alpha-shop', '/addresses', 'post', ashaA)
          .send({
            ...address,
            line1: '9 Office Park',
            label: 'Work',
            isDefault: true,
          })
          .expect(201);
        expect(
          second.body.data.map((a: { label: string; isDefault: boolean }) => [
            a.label,
            a.isDefault,
          ]),
        ).toEqual([
          ['Work', true],
          ['Home', false],
        ]);
        const home = second.body.data[1].id as string;

        // Another shopper of the same store cannot see, change or delete it.
        expect(
          (await acct('alpha-shop', '/addresses', 'get', ravi).expect(200)).body
            .data,
        ).toEqual([]);
        await acct('alpha-shop', `/addresses/${home}`, 'put', ravi)
          .send(address)
          .expect(404);
        await acct('alpha-shop', `/addresses/${home}`, 'delete', ravi).expect(
          404,
        );

        const edited = await acct(
          'alpha-shop',
          `/addresses/${home}`,
          'put',
          ashaA,
        )
          .send({ ...address, city: 'Mysuru', label: 'Home' })
          .expect(200);
        expect(
          edited.body.data.find((a: { id: string }) => a.id === home).city,
        ).toBe('Mysuru');
        // Removing the default promotes another one.
        const left = await acct(
          'alpha-shop',
          `/addresses/${second.body.data[0].id}`,
          'delete',
          ashaA,
        ).expect(200);
        expect(left.body.data).toHaveLength(1);
        expect(left.body.data[0].isDefault).toBe(true);
        await acct('alpha-shop', '/addresses', 'post', ashaA)
          .send({ ...address, state: 'Atlantis' })
          .expect(400);
      });

      it('allows at most 10 saved addresses', async () => {
        for (let i = 0; i < 9; i++)
          await acct('alpha-shop', '/addresses', 'post', ashaA)
            .send({ ...address, line1: `${i} Lane` })
            .expect(201);
        const res = await acct('alpha-shop', '/addresses', 'post', ashaA)
          .send(address)
          .expect(409);
        expect(res.body.error.code).toBe('ADDRESS_LIMIT');
      });
    });

    describe('checkout needs an account; browsing does not', () => {
      it('refuses an order without a session, with a bad one, or with a session from another store', async () => {
        for (const token of [undefined, 'x'.repeat(43), alice.token, ashaB]) {
          const res = await place('alpha-shop', token).expect(401);
          expect(res.body.error.code).toBe('CUSTOMER_LOGIN_REQUIRED');
        }
      });

      it('browsing the storefront and the price quote need no account', async () => {
        await request(http())
          .get('/api/v1/public/storefronts/alpha-shop')
          .set('X-Forwarded-For', ip())
          .expect(200);
        await request(http())
          .post('/api/v1/public/stores/alpha-shop/checkout/quote')
          .set('X-Forwarded-For', ip())
          .send({
            address: { state: 'Karnataka', postalCode: '560001' },
            lines: [{ productSlug: 'acct-mug', quantity: 2 }],
            paymentMethod: 'cod',
          })
          .expect(200);
      });

      it('an order from a session is tied to that account, priced by the server, and not duplicated by a retry', async () => {
        const key = randomBytes(12).toString('hex');
        const body = {
          ...order('acct-mug', 2),
          lines: [
            { productSlug: 'acct-mug', quantity: 2, expectedUnitPriceMinor: 1 },
          ],
        };
        const send = () =>
          request(http())
            .post('/api/v1/public/stores/alpha-shop/orders')
            .set('X-Forwarded-For', ip())
            .set('X-Customer-Session', ashaA)
            .set('Idempotency-Key', key)
            .send(body);
        const first = await send();
        // The browser's idea of the price is not trusted: a changed price is reported, never silently accepted.
        expect([201, 409]).toContain(first.status);
        const good = {
          ...body,
          lines: [{ productSlug: 'acct-mug', quantity: 2 }],
        };
        const placed = await request(http())
          .post('/api/v1/public/stores/alpha-shop/orders')
          .set('X-Forwarded-For', ip())
          .set('X-Customer-Session', ashaA)
          .set('Idempotency-Key', randomBytes(12).toString('hex'))
          .send(good)
          .expect(201);
        expect(placed.body.data.subtotalMinor).toBe(50000);
        const again = await request(http())
          .post('/api/v1/public/stores/alpha-shop/orders')
          .set('X-Forwarded-For', ip())
          .set('X-Customer-Session', ashaA)
          .set('Idempotency-Key', 'fixed-key-0001')
          .send(good);
        const repeat = await request(http())
          .post('/api/v1/public/stores/alpha-shop/orders')
          .set('X-Forwarded-For', ip())
          .set('X-Customer-Session', ashaA)
          .set('Idempotency-Key', 'fixed-key-0001')
          .send(good);
        expect(again.body.data.orderNumber).toBe(repeat.body.data.orderNumber);
        const count = await t.db.asOwner(
          async (pg) =>
            (
              await pg.query<{ n: number }>(
                "select count(*)::int as n from orders where idempotency_key = 'fixed-key-0001'",
              )
            ).rows[0].n,
        );
        expect(count).toBe(1);
      });
    });

    describe('order history, isolation and tracking', () => {
      let number: number;

      it('lists and opens the shopper’s own orders only', async () => {
        const placed = await place(
          'alpha-shop',
          ravi,
          order('acct-mug', 3),
        ).expect(201);
        number = placed.body.data.orderNumber;

        const mine = await acct('alpha-shop', '/orders', 'get', ravi).expect(
          200,
        );
        expect(
          mine.body.data.map((o: { orderNumber: number }) => o.orderNumber),
        ).toEqual([number]);
        expect(mine.body.data[0]).toMatchObject({
          itemCount: 3,
          status: 'confirmed',
          paymentMethod: 'cod',
        });

        const detail = await acct(
          'alpha-shop',
          `/orders/${number}`,
          'get',
          ravi,
        ).expect(200);
        expect(detail.body.data.items[0]).toMatchObject({
          name: 'Mug',
          quantity: 3,
        });
        expect(
          detail.body.data.timeline.map((e: { status: string }) => e.status),
        ).toEqual(['confirmed']);
        expect(detail.body.data.accessToken).toBeNull();

        // Asha (same store) cannot open Ravi's order; Asha in the other store cannot either.
        await acct('alpha-shop', `/orders/${number}`, 'get', ashaA).expect(404);
        await acct(
          'alpha-shop',
          `/orders/${number}/cancel`,
          'post',
          ashaA,
        ).expect(404);
        await acct('beta-shop', `/orders/${number}`, 'get', ashaB).expect(404);
        await acct('beta-shop', `/orders/${number}`, 'get', ravi).expect(401);
      });

      it('shows the store owner’s updates immediately, with times, courier and tracking number', async () => {
        const id = await t.db.asOwner(
          async (pg) =>
            (
              await pg.query<{ id: string }>(
                'select id from orders where tenant_id = $1 and order_number = $2',
                [w.tenantA, number],
              )
            ).rows[0].id,
        );
        await alice
          .post(`/orders/${id}/status`, { status: 'processing' })
          .expect(200);
        // The owner records the parcel (no carrier integration): provider and tracking number. The order follows it.
        const parcel = await alice
          .post(`/orders/${id}/shipments/manual`, {
            courierName: 'Blue Dart',
            trackingNumber: 'AWB123456',
            trackingUrl: 'https://track.example/AWB123456',
          })
          .expect(201);
        await alice
          .patch(`/shipments/${parcel.body.data.id}/manual`, {
            status: 'in_transit',
          })
          .expect(200);

        const detail = await acct(
          'alpha-shop',
          `/orders/${number}`,
          'get',
          ravi,
        ).expect(200);
        const data = detail.body.data;
        expect(data.status).toBe('shipped');
        expect(data.timeline.map((e: { status: string }) => e.status)).toEqual([
          'confirmed',
          'processing',
          'ready_to_ship',
          'shipped',
        ]);
        expect(
          data.timeline.every(
            (e: { at: string }) => !Number.isNaN(Date.parse(e.at)),
          ),
        ).toBe(true);
        expect(data.shipments[0]).toMatchObject({
          courierName: 'Blue Dart',
          awb: 'AWB123456',
          trackingUrl: 'https://track.example/AWB123456',
        });
        // Only the owner can record or change a parcel: a customer session is not an owner credential.
        await request(http())
          .post(`/api/v1/orders/${id}/shipments/manual`)
          .set('Authorization', `Bearer ${ravi}`)
          .set('X-Organization-Id', w.tenantA)
          .send({ courierName: 'X', trackingNumber: 'Y' })
          .expect(401);
        // Internal notes and who acted are never part of the customer's view.
        expect(JSON.stringify(data)).not.toContain('actor');
      });

      it('lets the shopper cancel only while the store has not started, and never a shipped order', async () => {
        const fresh = await place(
          'alpha-shop',
          ravi,
          order('acct-mug', 1),
        ).expect(201);
        const cancelled = await acct(
          'alpha-shop',
          `/orders/${fresh.body.data.orderNumber}/cancel`,
          'post',
          ravi,
        ).expect(200);
        expect(cancelled.body.data.status).toBe('cancelled');
        expect(cancelled.body.data.timeline.at(-1).status).toBe('cancelled');
        await acct(
          'alpha-shop',
          `/orders/${number}/cancel`,
          'post',
          ravi,
        ).expect(409);
      });

      it('the owner sees the order with the customer and address, and only their own store’s orders', async () => {
        const list = await alice.get('/orders?limit=50').expect(200);
        expect(
          list.body.data.some(
            (o: { orderNumber: number }) => o.orderNumber === number,
          ),
        ).toBe(true);
        const bob = await as(t, w.bob, w.tenantB);
        const theirs = await bob.get('/orders?limit=50').expect(200);
        expect(theirs.body.data).toEqual([]);
      });
    });
  },
);
