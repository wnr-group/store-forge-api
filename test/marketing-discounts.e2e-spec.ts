import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, type TestApp } from './support/app.js';
import { registerShopper } from './support/shopper.js';
import { createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

describe.skipIf(!migrationsAvailable)(
  'discount codes and campaigns over HTTP: rules, checkout, limits, isolation (migrations 0053-0054)',
  () => {
    let t: TestApp;
    const shopper: Record<string, string> = {};
    let w: World;
    let alice: Awaited<ReturnType<typeof as>>;
    let bob: Awaited<ReturnType<typeof as>>;
    let reader: Awaited<ReturnType<typeof as>>;
    let nobody: Awaited<ReturnType<typeof as>>;
    let collectionId = '';
    let penId = '';
    let mugId = '';
    const anon = () => request(t.app.getHttpServer());
    const api = (p: string) => `/api/v1${p}`;
    let n = 0;
    /** Every shopper request comes from its own address, like real traffic (the place-order limit is per client). */
    const ip = () =>
      `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

    const MUG = { productSlug: 'dc-mug', quantity: 2 }; // 2 x 50000 = 100000
    const PEN = { productSlug: 'dc-pen', quantity: 1 }; // 10000

    const create = (over: Record<string, unknown> = {}) =>
      alice.post('/marketing/discounts', {
        code: `CODE${++n}`,
        kind: 'percentage',
        value: 1000,
        ...over,
      });
    const order = (
      discountCode: string | undefined,
      opts: { lines?: object[]; email?: string; store?: string } = {},
    ) =>
      anon()
        .post(api(`/public/stores/${opts.store ?? 'alpha-shop'}/orders`))
        .set('X-Customer-Session', shopper[opts.store ?? 'alpha-shop'])
        .set('X-Forwarded-For', ip())
        .set('Idempotency-Key', randomBytes(12).toString('hex'))
        .send({
          lines: opts.lines ?? [MUG],
          customer: {
            fullName: 'Asha Rao',
            email: opts.email ?? `asha${++n}@example.test`,
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
          ...(discountCode ? { discountCode } : {}),
        });
    const validate = (code: string, lines: object[] = [MUG], email?: string) =>
      anon()
        .post(api('/public/stores/alpha-shop/discounts/validate'))
        .set('X-Forwarded-For', ip())
        .send({ code, lines, ...(email ? { customerEmail: email } : {}) });

    beforeAll(async () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
        randomBytes(32).toString('base64');
      process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
      const db = await createTestDb();
      w = await seedWorld(db);
      await db.asOwner(async (pg) => {
        const p = async (
          tenant: string,
          name: string,
          slug: string,
          price: number,
        ) =>
          (
            await pg.query<{ id: string }>(
              `insert into products (tenant_id, name, slug, price_minor, quantity, status) values ($1,$2,$3,$4,1000,'active') returning id`,
              [tenant, name, slug, price],
            )
          ).rows[0].id;
        mugId = await p(w.tenantA, 'Mug', 'dc-mug', 50000);
        penId = await p(w.tenantA, 'Pen', 'dc-pen', 10000);
        await p(w.tenantB, 'Beta mug', 'dc-beta', 50000);
        collectionId = (
          await pg.query<{ id: string }>(
            `insert into collections (tenant_id, name, slug) values ($1,'Stationery','stationery') returning id`,
            [w.tenantA],
          )
        ).rows[0].id;
        await pg.query(
          `insert into collection_products (tenant_id, collection_id, product_id) values ($1,$2,$3)`,
          [w.tenantA, collectionId, penId],
        );
      });
      t = await createTestApp(db);
      shopper['alpha-shop'] = await registerShopper(t.app, 'alpha-shop');
      shopper['beta-shop'] = await registerShopper(t.app, 'beta-shop');
      alice = await as(t, w.alice, w.tenantA);
      bob = await as(t, w.bob, w.tenantB);
      reader = await as(t, w.members.reader, w.tenantA);
      nobody = await as(t, w.members.nothing, w.tenantA);
      await alice
        .put('/payments/cod', { enabled: true, minOrderMinor: 0, feeMinor: 0 })
        .expect(200);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('access and validation', () => {
      it('needs a signed-in member with orders access; read-only members cannot change anything', async () => {
        await anon().get(api('/marketing/discounts')).expect(401);
        await nobody.get('/marketing/discounts').expect(403);
        await nobody.get('/marketing/campaigns').expect(403);
        await reader.get('/marketing/discounts').expect(200);
        await reader
          .post('/marketing/discounts', {
            code: 'NOPE10',
            kind: 'fixed',
            value: 100,
          })
          .expect(403);
        await reader.post('/marketing/campaigns', { name: 'Nope' }).expect(403);
      });

      it('rejects bad input and says what is wrong', async () => {
        await create({ code: 'a' }).expect(400);
        await create({ kind: 'bogus' }).expect(400);
        await create({ value: 0 }).expect(400);
        await create({ tenantId: w.tenantB }).expect(400);
        for (const bad of [
          { value: 10001 },
          { kind: 'fixed', value: 500, maxDiscountMinor: 100 },
          {
            startsAt: '2030-01-02T00:00:00Z',
            expiresAt: '2030-01-01T00:00:00Z',
          },
          { appliesTo: 'products' },
          { appliesTo: 'collections', collectionIds: [] },
        ]) {
          const res = await create(bad).expect(400);
          expect(res.body.error.code).toBe('DISCOUNT_INVALID');
        }
      });

      it('stores codes in capitals and keeps them unique per store, not across stores', async () => {
        const made = (await create({ code: 'unique-1' }).expect(201)).body.data;
        expect(made.code).toBe('UNIQUE-1');
        const dup = await create({ code: 'UNIQUE-1' }).expect(409);
        expect(dup.body.error.code).toBe('DISCOUNT_CODE_TAKEN');
        await bob
          .post('/marketing/discounts', {
            code: 'UNIQUE-1',
            kind: 'fixed',
            value: 100,
          })
          .expect(201);
      });

      it("cannot target another store's products or campaign", async () => {
        const betaProduct = (await bob.get('/products').expect(200)).body
          .data?.[0];
        const res = await create({
          appliesTo: 'products',
          productIds: [
            betaProduct?.id ?? '00000000-0000-4000-8000-000000000000',
          ],
        });
        expect(res.status).toBe(400);
        const camp = (
          await bob
            .post('/marketing/campaigns', { name: 'Bob camp' })
            .expect(201)
        ).body.data;
        const cross = await create({ campaignId: camp.id });
        expect(cross.status).toBe(400);
        expect(cross.body.error.code).toBe('CAMPAIGN_NOT_FOUND');
      });
    });

    describe('applying a code at checkout', () => {
      it('takes a percentage off the items and records it on the order', async () => {
        await create({ code: 'TEN' }).expect(201);
        const placed = (await order('ten').expect(201)).body.data;
        expect(placed.subtotalMinor).toBe(100000);
        expect(placed.discountMinor).toBe(10000);
        expect(placed.totalMinor).toBe(90000);
      });

      it('agrees between the quote, the validation and the order', async () => {
        await create({ code: 'FIVEK', kind: 'fixed', value: 5000 }).expect(201);
        const v = (await validate('fivek').expect(200)).body.data;
        expect(v).toMatchObject({
          valid: true,
          discountMinor: 5000,
          eligibleSubtotalMinor: 100000,
        });
        const q = (
          await anon()
            .post(api('/public/stores/alpha-shop/checkout/quote'))
            .send({
              address: {
                state: 'Karnataka',
                city: 'Bengaluru',
                postalCode: '560001',
              },
              lines: [MUG],
              paymentMethod: 'cod',
              discountCode: 'fivek',
            })
            .expect(200)
        ).body.data;
        expect(q).toMatchObject({
          discountMinor: 5000,
          discountCode: 'FIVEK',
          totalMinor: 95000,
        });
        const placed = (await order('FIVEK').expect(201)).body.data;
        expect(placed.totalMinor).toBe(q.totalMinor);
      });

      it('applies a maximum discount', async () => {
        await create({
          code: 'CAPPED',
          value: 5000,
          maxDiscountMinor: 7000,
        }).expect(201);
        expect(
          (await order('CAPPED').expect(201)).body.data.discountMinor,
        ).toBe(7000);
      });

      it('refuses an unknown code, a disabled code, an expired one and one not started', async () => {
        const unknown = await order('NOSUCH').expect(409);
        expect(unknown.body.error).toMatchObject({
          code: 'DISCOUNT_INVALID',
          details: { reason: 'NOT_FOUND' },
        });
        const off = (
          await create({ code: 'OFFCODE', isActive: false }).expect(201)
        ).body.data;
        expect(
          (await order('OFFCODE').expect(409)).body.error.details.reason,
        ).toBe('INACTIVE');
        expect(off.status).toBe('disabled');
        await create({
          code: 'OLDONE',
          startsAt: '2020-01-01T00:00:00Z',
          expiresAt: '2020-02-01T00:00:00Z',
        }).expect(201);
        expect(
          (await order('OLDONE').expect(409)).body.error.details.reason,
        ).toBe('EXPIRED');
        await create({
          code: 'SOONONE',
          startsAt: '2099-01-01T00:00:00Z',
        }).expect(201);
        expect(
          (await order('SOONONE').expect(409)).body.error.details.reason,
        ).toBe('NOT_STARTED');
        // A refused code never creates an order: the next placed order is still the next number.
      });

      it('switching a code off or on takes effect at once', async () => {
        const c = (await create({ code: 'TOGGLE' }).expect(201)).body.data;
        await order('TOGGLE').expect(201);
        await alice
          .patch(`/marketing/discounts/${c.id}`, { isActive: false })
          .expect(200);
        expect(
          (await order('TOGGLE').expect(409)).body.error.details.reason,
        ).toBe('INACTIVE');
        await alice
          .patch(`/marketing/discounts/${c.id}`, { isActive: true })
          .expect(200);
        await order('TOGGLE').expect(201);
      });

      it('enforces the minimum purchase', async () => {
        await create({ code: 'BIGSPEND', minSubtotalMinor: 150000 }).expect(
          201,
        );
        const res = await order('BIGSPEND').expect(409);
        expect(res.body.error.details).toMatchObject({
          reason: 'MIN_SUBTOTAL',
          minSubtotalMinor: 150000,
        });
        await order('BIGSPEND', { lines: [{ ...MUG, quantity: 3 }] }).expect(
          201,
        );
      });

      it('applies only to selected products, and only to selected collections', async () => {
        await create({
          code: 'PENONLY',
          appliesTo: 'products',
          productIds: [penId],
        }).expect(201);
        const mixed = (
          await order('PENONLY', { lines: [MUG, PEN] }).expect(201)
        ).body.data;
        expect(mixed.discountMinor).toBe(1000); // 10% of the pen only
        expect(
          (await order('PENONLY').expect(409)).body.error.details.reason,
        ).toBe('NO_ELIGIBLE_ITEMS');

        await create({
          code: 'STATIONERY',
          appliesTo: 'collections',
          collectionIds: [collectionId],
          kind: 'fixed',
          value: 4000,
        }).expect(201);
        const col = (
          await order('STATIONERY', { lines: [MUG, PEN] }).expect(201)
        ).body.data;
        expect(col.discountMinor).toBe(4000);
        const detail = (
          await alice.get('/marketing/discounts?search=STATIONERY').expect(200)
        ).body.data[0];
        const full = (
          await alice.get(`/marketing/discounts/${detail.id}`).expect(200)
        ).body.data;
        expect(full.collections).toEqual([
          { id: collectionId, name: 'Stationery' },
        ]);
      });
    });

    describe('usage limits', () => {
      it('stops after the total limit, and frees a use when an order is cancelled', async () => {
        await create({ code: 'TWICE', usageLimit: 2 }).expect(201);
        const first = (await order('TWICE').expect(201)).body.data;
        await order('TWICE').expect(201);
        expect(
          (await order('TWICE').expect(409)).body.error.details.reason,
        ).toBe('USAGE_LIMIT');
        expect((await validate('TWICE').expect(200)).body.data).toMatchObject({
          valid: false,
          reason: 'USAGE_LIMIT',
        });
        await anon()
          .post(
            api(`/public/stores/alpha-shop/orders/${first.orderNumber}/cancel`),
          )
          .set('X-Order-Token', first.accessToken)
          .expect(200);
        await order('TWICE').expect(201);
        const row = (
          await alice.get('/marketing/discounts?search=TWICE').expect(200)
        ).body.data[0];
        expect(row.status).toBe('exhausted');
        expect(row.performance.redemptions).toBe(2);
      });

      it('limits each customer, by email, and does not mind capital letters', async () => {
        await create({ code: 'ONCEEACH', perCustomerLimit: 1 }).expect(201);
        await order('ONCEEACH', { email: 'Repeat@Example.test' }).expect(201);
        const again = await order('ONCEEACH', {
          email: 'repeat@example.test',
        }).expect(409);
        expect(again.body.error.details.reason).toBe('CUSTOMER_LIMIT');
        expect(
          (await validate('ONCEEACH', [MUG], 'REPEAT@example.test').expect(200))
            .body.data.reason,
        ).toBe('CUSTOMER_LIMIT');
        await order('ONCEEACH', { email: 'someone.else@example.test' }).expect(
          201,
        );
      });

      it('lets only one of two simultaneous orders take the last use', async () => {
        await create({ code: 'LASTONE', usageLimit: 1 }).expect(201);
        const results = await Promise.all([order('LASTONE'), order('LASTONE')]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409,
        ]);
        const row = (
          await alice.get('/marketing/discounts?search=LASTONE').expect(200)
        ).body.data[0];
        expect(row.performance.redemptions).toBe(1);
      });
    });

    describe('campaigns', () => {
      it('creates a draft, moves it through its states and refuses nonsense', async () => {
        const c = (
          await alice
            .post('/marketing/campaigns', { name: 'Festive' })
            .expect(201)
        ).body.data;
        expect(c).toMatchObject({ status: 'draft', phase: 'draft' });
        expect(
          (await alice.post('/marketing/campaigns', { name: 'festive' })).body
            .error.code,
        ).toBe('CAMPAIGN_NAME_TAKEN');
        await alice
          .post('/marketing/campaigns', {
            name: 'Backwards',
            startsAt: '2030-02-01T00:00:00Z',
            endsAt: '2030-01-01T00:00:00Z',
          })
          .expect(400);
        const live = (
          await alice
            .post(`/marketing/campaigns/${c.id}/status`, { status: 'active' })
            .expect(200)
        ).body.data;
        expect(live.phase).toBe('live');
        expect(
          (
            await alice
              .post(`/marketing/campaigns/${c.id}/status`, { status: 'paused' })
              .expect(200)
          ).body.data.phase,
        ).toBe('paused');
        await alice
          .post(`/marketing/campaigns/${c.id}/status`, { status: 'completed' })
          .expect(200);
        const res = await alice
          .post(`/marketing/campaigns/${c.id}/status`, { status: 'active' })
          .expect(409);
        expect(res.body.error.code).toBe('CAMPAIGN_STATUS_INVALID');
        await alice
          .patch(`/marketing/campaigns/${c.id}`, { name: 'Renamed' })
          .expect(409);
        await alice
          .post(`/marketing/campaigns/${c.id}/status`, { status: 'bogus' })
          .expect(400);
      });

      it('its codes work only while the campaign is live', async () => {
        const camp = (
          await alice.post('/marketing/campaigns', { name: 'Gate' }).expect(201)
        ).body.data;
        const code = (
          await create({ code: 'GATED', campaignId: camp.id }).expect(201)
        ).body.data;
        expect(code.campaignName).toBe('Gate');
        expect(
          (await order('GATED').expect(409)).body.error.details.reason,
        ).toBe('CAMPAIGN_INACTIVE');
        await alice
          .post(`/marketing/campaigns/${camp.id}/status`, { status: 'active' })
          .expect(200);
        await order('GATED').expect(201);
        await alice
          .post(`/marketing/campaigns/${camp.id}/status`, { status: 'paused' })
          .expect(200);
        expect(
          (await order('GATED').expect(409)).body.error.details.reason,
        ).toBe('CAMPAIGN_INACTIVE');
        expect(
          (await alice.get('/marketing/discounts?search=GATED').expect(200))
            .body.data[0].status,
        ).toBe('campaign_inactive');
      });

      it('does not work after the campaign end date, and cannot be reactivated past it', async () => {
        const camp = (
          await alice
            .post('/marketing/campaigns', {
              name: 'Short',
              startsAt: '2020-01-01T00:00:00Z',
              endsAt: '2020-02-01T00:00:00Z',
            })
            .expect(201)
        ).body.data;
        const res = await alice
          .post(`/marketing/campaigns/${camp.id}/status`, { status: 'active' })
          .expect(400);
        expect(res.body.error.code).toBe('CAMPAIGN_ENDED');
      });

      it('associates codes and reports the performance of the campaign', async () => {
        const a = (await create({ code: 'PERFA' }).expect(201)).body.data;
        const b = (
          await create({ code: 'PERFB', kind: 'fixed', value: 2000 }).expect(
            201,
          )
        ).body.data;
        const camp = (
          await alice
            .post('/marketing/campaigns', {
              name: 'Perf',
              discountIds: [a.id, b.id],
            })
            .expect(201)
        ).body.data;
        expect(camp.discounts.map((d: { code: string }) => d.code)).toEqual([
          'PERFA',
          'PERFB',
        ]);
        await alice
          .post(`/marketing/campaigns/${camp.id}/status`, { status: 'active' })
          .expect(200);
        await order('PERFA').expect(201); // 10000 off 100000
        await order('PERFB').expect(201); // 2000 off 100000
        const view = (
          await alice.get(`/marketing/campaigns/${camp.id}`).expect(200)
        ).body.data;
        expect(view.performance).toMatchObject({
          discountCodes: 2,
          redemptions: 2,
          discountTotalMinor: 12000,
          grossSalesMinor: 200000,
          netSalesMinor: 188000,
          averageOrderMinor: 94000,
        });
        await alice
          .patch(`/marketing/campaigns/${camp.id}`, { discountIds: [a.id] })
          .expect(200);
        expect(
          (await alice.get(`/marketing/discounts/${b.id}`).expect(200)).body
            .data.campaignId,
        ).toBeNull();
      });
    });

    describe('history, deleting and isolation', () => {
      it('reports the performance of a code from its real orders', async () => {
        const c = (await create({ code: 'STATS' }).expect(201)).body.data;
        expect(c.performance).toMatchObject({
          redemptions: 0,
          discountTotalMinor: 0,
          averageOrderMinor: 0,
        });
        await order('STATS').expect(201);
        await order('STATS', { lines: [{ ...MUG, quantity: 1 }] }).expect(201);
        const p = (await alice.get(`/marketing/discounts/${c.id}`).expect(200))
          .body.data.performance;
        expect(p).toEqual({
          redemptions: 2,
          discountTotalMinor: 15000,
          grossSalesMinor: 150000,
          netSalesMinor: 135000,
          averageOrderMinor: 67500,
        });
      });

      it('deletes an unused code but keeps one that has been used', async () => {
        const fresh = (await create({ code: 'DELME' }).expect(201)).body.data;
        await alice.delete(`/marketing/discounts/${fresh.id}`).expect(200);
        await alice.get(`/marketing/discounts/${fresh.id}`).expect(404);
        const used = (
          await alice.get('/marketing/discounts?search=STATS').expect(200)
        ).body.data[0];
        const res = await alice
          .delete(`/marketing/discounts/${used.id}`)
          .expect(409);
        expect(res.body.error.code).toBe('DISCOUNT_HAS_USE');
      });

      it('pages and filters the list', async () => {
        const page = await alice
          .get('/marketing/discounts?limit=3&page=1&sortBy=code&sortOrder=asc')
          .expect(200);
        expect(page.body.data).toHaveLength(3);
        expect(page.body.meta.total).toBeGreaterThan(3);
        const off = (
          await alice.get('/marketing/discounts?status=disabled').expect(200)
        ).body.data;
        expect(off.length).toBeGreaterThan(0);
        expect(
          off.every((d: { status: string }) => d.status === 'disabled'),
        ).toBe(true);
        await alice.get('/marketing/discounts?status=nonsense').expect(400);
      });

      it("never lets one store see, change or use another store's codes", async () => {
        const betaCode = (
          await bob
            .post('/marketing/discounts', {
              code: 'BETAONLY',
              kind: 'fixed',
              value: 1000,
            })
            .expect(201)
        ).body.data;
        const mine = (
          await alice.get('/marketing/discounts?limit=100').expect(200)
        ).body.data;
        expect(mine.some((d: { code: string }) => d.code === 'BETAONLY')).toBe(
          false,
        );
        await alice.get(`/marketing/discounts/${betaCode.id}`).expect(404);
        await alice
          .patch(`/marketing/discounts/${betaCode.id}`, { isActive: false })
          .expect(404);
        await alice.delete(`/marketing/discounts/${betaCode.id}`).expect(404);
        // Alice's store cannot use Bob's code, and Bob's store cannot use Alice's.
        expect(
          (await order('BETAONLY').expect(409)).body.error.details.reason,
        ).toBe('NOT_FOUND');
        const betaOrder = await order('TEN', {
          store: 'beta-shop',
          lines: [{ productSlug: 'dc-beta', quantity: 1 }],
        });
        expect(betaOrder.status).toBe(409);
        // A code in the other store's campaign is not reachable either.
        expect(
          (
            await alice.get('/marketing/campaigns?limit=100').expect(200)
          ).body.data.some((c: { name: string }) => c.name === 'Bob camp'),
        ).toBe(false);
        // The store header cannot be used to reach another store's data.
        const spoof = await as(t, w.alice, w.tenantB);
        await spoof.get('/marketing/discounts').expect(403);
        void mugId;
      });

      it('does not trust an amount sent by the browser', async () => {
        const placed = await anon()
          .post(api('/public/stores/alpha-shop/orders'))
          .set('X-Customer-Session', shopper['alpha-shop'])
          .set('Idempotency-Key', randomBytes(12).toString('hex'))
          .send({
            lines: [MUG],
            customer: {
              fullName: 'A B',
              email: 'cheat@example.test',
              phone: '9876543210',
            },
            shippingAddress: {
              fullName: 'A B',
              phone: '9876543210',
              line1: '1 Road',
              city: 'Bengaluru',
              state: 'Karnataka',
              postalCode: '560001',
            },
            paymentMethod: 'cod',
            discountMinor: 99999,
          });
        expect(placed.status).toBe(400);
      });
    });
  },
);
