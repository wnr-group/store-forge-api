import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { rowsOf } from '../src/database/database.service.js';
import { CarriersService } from '../src/modules/shipping/carriers.service.js';
import { asUser, migrationsAvailable } from './support/pglite.js';
import {
  SR,
  createShipmentsWorld,
  type ShipmentsWorld,
} from './support/shipments-world.js';

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe.skipIf(!migrationsAvailable)(
  'shipments: booking, failures, partial shipments, cancelling (migration 0051)',
  () => {
    let s: ShipmentsWorld;
    /** Books with Shiprocket unless the test says otherwise (selection is manual in this world). */
    const create = (orderId: string, dto: Record<string, unknown> = {}) =>
      s.shipments.create(s.owner(), orderId, {
        providerCode: 'shiprocket',
        ...dto,
      } as never);
    const createAuto = (orderId: string) =>
      s.shipments.create(s.owner(), orderId, {} as never);

    beforeAll(async () => {
      s = await createShipmentsWorld();
    });
    afterAll(() => s.t.close());

    describe('booking a cash-on-delivery order', () => {
      it('books with the carrier, records the waybill and moves the order to ready to ship', async () => {
        const o = await s.codOrder('sh-mug', 2);
        const sh = await create(o.id);
        expect(sh).toMatchObject({
          status: 'created',
          providerCode: 'shiprocket',
          courierName: 'Xpressbees Surface',
          paymentMode: 'cod',
          codAmountMinor: o.total,
          weightGrams: 800,
          orderNumber: o.number,
          hasLabel: false,
          labelUrl: 'https://labels.shiprocket.test/label.pdf',
          failureReason: null,
        });
        expect(sh.awb).toMatch(/^SRAWB/);
        expect(sh.items).toEqual([
          expect.objectContaining({ name: 'sh-mug', quantity: 2 }),
        ]);
        expect(sh.events.map((e) => e.status)).toEqual(['created']);

        expect(await s.orderStatus(o.id)).toBe('ready_to_ship');
        expect(await s.fulfillment(o.id)).toBe('fulfilled');
        expect(await s.history(o.id)).toEqual(
          expect.arrayContaining(['processing:owner', 'ready_to_ship:owner']),
        );
      });

      it('sends the carrier what the order saved: the amount to collect, the weight, the address and a stable reference', async () => {
        const sent = s.carrier.to(`${SR}/orders/create/adhoc`).at(-1)!
          .json as Record<string, unknown>;
        expect(sent).toMatchObject({
          payment_method: 'COD',
          sub_total: 1000,
          weight: 0.8,
          pickup_location: 'Primary',
          billing_pincode: '560001',
          billing_phone: '9876543210',
          billing_email: 'asha@example.test',
        });
        expect(sent.order_id).toMatch(/^SF-\d+-[0-9a-f]{8}$/);
        expect(sent.order_items).toEqual([
          expect.objectContaining({ units: 2, selling_price: 500 }),
        ]);
      });
    });

    describe('booking a prepaid order', () => {
      it('sends prepaid parcels with no cash to collect', async () => {
        const o = await s.paidOrder('sh-lamp', 1);
        const sh = await create(o.id, {
          lengthCm: 30,
          breadthCm: 20,
          heightCm: 10,
        });
        expect(sh).toMatchObject({
          paymentMode: 'prepaid',
          codAmountMinor: 0,
          weightGrams: 1500,
        });
        const sent = s.carrier.to(`${SR}/orders/create/adhoc`).at(-1)!
          .json as Record<string, unknown>;
        expect(sent).toMatchObject({
          payment_method: 'Prepaid',
          length: 30,
          breadth: 20,
          height: 10,
          weight: 1.5,
        });
      });

      it('uses the parcel weight the Owner enters (packaging) over the sum of the items', async () => {
        const o = await s.paidOrder('sh-mug', 1);
        expect((await create(o.id, { weightGrams: 650 })).weightGrams).toBe(
          650,
        );
      });
    });

    describe('what may be shipped', () => {
      it('refuses an order that is unpaid, cancelled or not found, saving nothing', async () => {
        const waiting = await s.codOrder();
        await s.t.asOwner((pg) =>
          pg.query(
            `update orders set payment_method = 'razorpay', payment_status = 'unpaid', status = 'pending_payment' where id = $1`,
            [waiting.id],
          ),
        );
        expect((await failure(create(waiting.id))).code).toBe(
          'ORDER_NOT_SHIPPABLE',
        );

        const unpaid = await s.paidOrder();
        await s.t.asOwner((pg) =>
          pg.query(
            `update orders set payment_status = 'unpaid' where id = $1`,
            [unpaid.id],
          ),
        );
        expect((await failure(create(unpaid.id))).code).toBe('ORDER_NOT_PAID');

        const cancelled = await s.codOrder();
        await s.t.asOwner((pg) =>
          pg.query(`update orders set status = 'cancelled' where id = $1`, [
            cancelled.id,
          ]),
        );
        expect((await failure(create(cancelled.id))).code).toBe(
          'ORDER_NOT_SHIPPABLE',
        );

        expect(
          (await failure(create('00000000-0000-4000-8000-000000000000'))).code,
        ).toBe('ORDER_NOT_FOUND');
        const rows = await s.one<number>(
          'select count(*)::int as v from shipments where order_id = any($1::uuid[])',
          [[waiting.id, unpaid.id, cancelled.id]],
        );
        expect(rows).toBe(0);
      });

      it('needs a parcel weight when the products have none, and complete sizes when sizes are given', async () => {
        const o = await s.paidOrder('sh-noweight', 1);
        const e = await failure(create(o.id));
        expect(e.code).toBe('WEIGHT_REQUIRED');
        expect(e.details).toHaveProperty('weightGrams');
        expect((await create(o.id, { weightGrams: 300 })).weightGrams).toBe(
          300,
        );
        const o2 = await s.paidOrder('sh-mug', 1);
        expect((await failure(create(o2.id, { lengthCm: 10 }))).code).toBe(
          'DIMENSIONS_INCOMPLETE',
        );
      });

      it('needs the pickup address', async () => {
        const saved = await s.t.asOwner(async (pg) => {
          const r = await pg.query(
            'select * from tenant_shipping_origin where tenant_id = $1',
            [s.w.tenantA],
          );
          await pg.query(
            'delete from tenant_shipping_origin where tenant_id = $1',
            [s.w.tenantA],
          );
          return r.rows[0] as Record<string, unknown>;
        });
        const o = await s.paidOrder();
        expect((await failure(create(o.id))).code).toBe('ORIGIN_MISSING');
        await s.tools.saveOrigin(s.owner(), {
          name: saved.name,
          phone: saved.phone,
          line1: saved.line1,
          city: saved.city,
          state: saved.state,
          postalCode: saved.postal_code,
        } as never);
        expect((await create(o.id)).status).toBe('created');
      });
    });

    describe('choosing the carrier', () => {
      it('uses the carrier named, and refuses one that is not connected without saving anything', async () => {
        const o = await s.paidOrder();
        const e = await failure(create(o.id, { providerCode: 'delhivery' }));
        expect(e.code).toBe('CARRIER_NOT_AVAILABLE');
        expect(
          await s.one<number>(
            'select count(*)::int as v from shipments where order_id = $1',
            [o.id],
          ),
        ).toBe(0);
        expect(
          (await failure(create(o.id, { providerCode: 'nosuchcarrier' }))).code,
        ).toBe('CARRIER_NOT_AVAILABLE');
        expect(await s.orderStatus(o.id)).toBe('confirmed');
      });

      it('refuses a carrier that is switched off', async () => {
        const o = await s.paidOrder();
        await s.carriers.setEnabled(s.owner(), 'shiprocket', {
          enabled: false,
        });
        const e = await failure(create(o.id, { providerCode: 'shiprocket' }));
        expect(e.code).toBe('CARRIER_NOT_AVAILABLE');
        expect(e.message).toMatch(/switched off/);
        await s.carriers.setEnabled(s.owner(), 'shiprocket', { enabled: true });
      });

      it('uses the carrier and service priced at checkout, else the settings, else asks', async () => {
        const o = await s.paidOrder();
        await s.t.asOwner((pg) =>
          pg.query(
            `update orders set shipping_carrier_code = 'shiprocket', shipping_service_code = '10' where id = $1`,
            [o.id],
          ),
        );
        const sh = await createAuto(o.id);
        expect(sh.providerCode).toBe('shiprocket');
        expect(sh.serviceCode).toBe('10');
        const sent = s.carrier.to(`${SR}/courier/assign/awb`).at(-1)!
          .json as Record<string, unknown>;
        expect(sent.courier_id).toBe(10);

        // Manual selection with nothing chosen: the Owner is asked rather than a carrier being guessed.
        const o2 = await s.paidOrder();
        const e = await failure(createAuto(o2.id));
        expect(e.code).toBe('CARRIER_REQUIRED');
        expect(e.details).toEqual({ providerCode: 'Choose a carrier.' });
      });

      it('chooses automatically when the Owner’s settings say so', async () => {
        await s.carriers.savePreferences(s.owner(), {
          selectionMode: 'automatic',
          strategy: 'lowest_cost',
        });
        const o = await s.paidOrder();
        const sh = await createAuto(o.id);
        expect(sh).toMatchObject({
          providerCode: 'shiprocket',
          serviceCode: '10',
        });
        await s.carriers.savePreferences(s.owner(), {
          selectionMode: 'manual',
          strategy: 'lowest_cost',
        });
      });
    });

    describe('when the carrier does not cooperate', () => {
      it('keeps a saved shipment when the carrier does not answer, blocks a second one, and a retry books it once', async () => {
        const o = await s.paidOrder();
        s.sr.failCreate.push({ networkError: true });
        const e = await failure(create(o.id, { providerCode: 'shiprocket' }));
        expect(e).toMatchObject({
          kind: 'UNAVAILABLE',
          code: 'SHIPMENT_PENDING',
        });
        const pendingId = (e.details as { shipmentId: string }).shipmentId;
        expect(await s.shipmentRow(pendingId)).toMatchObject({
          status: 'creating',
          awb: null,
          attempts: 1,
        });
        expect(await s.orderStatus(o.id)).toBe('confirmed');

        // Nobody can start a second booking for the same order meanwhile.
        const blocked = await failure(
          create(o.id, { providerCode: 'shiprocket' }),
        );
        expect(blocked.code).toBe('SHIPMENT_IN_PROGRESS');
        expect(blocked.details).toEqual({ shipmentId: pendingId });

        const done = await s.shipments.retry(s.owner(), pendingId);
        expect(done).toMatchObject({ id: pendingId, status: 'created' });
        expect(await s.shipmentRow(pendingId)).toMatchObject({ attempts: 2 });
        expect(await s.orderStatus(o.id)).toBe('ready_to_ship');
        expect(
          await s.one<number>(
            'select count(*)::int as v from shipments where order_id = $1',
            [o.id],
          ),
        ).toBe(1);
      });

      it('resumes from where the carrier got to: the carrier order is never created twice', async () => {
        const o = await s.paidOrder();
        const before = s.sr.ordersCreated;
        s.sr.failAssign.push({
          status: 422,
          body: { message: 'Courier not available for this lane' },
        });
        const e = await failure(create(o.id));
        expect(e.code).toBe('SHIPMENT_PENDING');
        expect(e.message).toMatch(/fix the problem and retry/);
        const id = (e.details as { shipmentId: string }).shipmentId;
        expect(await s.shipmentRow(id)).toMatchObject({ status: 'creating' });
        expect((await s.shipmentRow(id)).provider_shipment_id).toBeTruthy();

        const done = await s.shipments.retry(s.owner(), id);
        expect(done.status).toBe('created');
        expect(s.sr.ordersCreated).toBe(before + 1);
      });

      it('marks a shipment failed when the carrier clearly refuses it before accepting anything, and lets the Owner try again', async () => {
        const o = await s.paidOrder();
        s.sr.failCreate.push({
          status: 422,
          body: { message: 'Invalid delivery pincode' },
        });
        const e = await failure(create(o.id));
        expect(e.code).toBe('CARRIER_REJECTED');
        const id = (e.details as { shipmentId: string }).shipmentId;
        expect(await s.shipmentRow(id)).toMatchObject({ status: 'failed' });
        expect(await s.orderStatus(o.id)).toBe('confirmed');
        expect((await create(o.id)).status).toBe('created');
        expect((await failure(s.shipments.retry(s.owner(), id))).code).toBe(
          'SHIPMENT_NOT_PENDING',
        );
      });

      it('can abandon a saved shipment the carrier never heard of', async () => {
        const o = await s.paidOrder();
        s.sr.failCreate.push({ networkError: true });
        const id = (
          (await failure(create(o.id))).details as { shipmentId: string }
        ).shipmentId;
        expect((await s.shipments.cancel(s.owner(), id)).status).toBe(
          'cancelled',
        );
        expect((await create(o.id)).status).toBe('created');
      });
    });

    describe('partial shipments', () => {
      it('ships an order in parts and tracks how much has gone', async () => {
        const o = await s.paidOrder('sh-mug', 3);
        const items = (await s.shipments.listForOrder(s.owner(), o.id)).length;
        expect(items).toBe(0);
        const orderItem = await s.one<string>(
          'select id as v from order_items where order_id = $1',
          [o.id],
        );

        const first = await create(o.id, {
          items: [{ orderItemId: orderItem, quantity: 1 }],
        });
        expect(first.items[0].quantity).toBe(1);
        expect(first.weightGrams).toBe(400);
        expect(await s.fulfillment(o.id)).toBe('partial');
        expect(await s.orderStatus(o.id)).toBe('ready_to_ship');

        const tooMany = await failure(
          create(o.id, { items: [{ orderItemId: orderItem, quantity: 3 }] }),
        );
        expect(tooMany.code).toBe('SHIPMENT_ITEMS_INVALID');
        expect(tooMany.details).toEqual({
          'items.0': 'Only 2 of sh-mug are left to ship.',
        });

        const rest = await create(o.id);
        expect(rest.items[0].quantity).toBe(2);
        expect(await s.fulfillment(o.id)).toBe('fulfilled');
        expect((await failure(create(o.id))).code).toBe(
          'SHIPMENT_ITEMS_INVALID',
        );
        expect(
          (await s.shipments.listForOrder(s.owner(), o.id)).map(
            (x) => x.status,
          ),
        ).toEqual(['created', 'created']);
      });

      it('releases the items of a cancelled shipment so they can go again', async () => {
        const o = await s.paidOrder('sh-mug', 2);
        const a = await create(o.id);
        await s.shipments.cancel(s.owner(), a.id);
        expect(await s.fulfillment(o.id)).toBe('unfulfilled');
        expect((await create(o.id)).items[0].quantity).toBe(2);
      });

      it('never splits a cash-on-delivery order, and refuses items that are not the order’s or repeated', async () => {
        const cod = await s.codOrder('sh-mug', 2);
        const itemId = await s.one<string>(
          'select id as v from order_items where order_id = $1',
          [cod.id],
        );
        expect(
          (
            await failure(
              create(cod.id, { items: [{ orderItemId: itemId, quantity: 1 }] }),
            )
          ).code,
        ).toBe('SHIPMENT_COD_SPLIT');

        const paid = await s.paidOrder('sh-mug', 2);
        const paidItem = await s.one<string>(
          'select id as v from order_items where order_id = $1',
          [paid.id],
        );
        const bad = await failure(
          create(paid.id, {
            items: [
              { orderItemId: itemId, quantity: 1 },
              { orderItemId: paidItem, quantity: 1 },
              { orderItemId: paidItem, quantity: 1 },
            ],
          }),
        );
        expect(bad.details).toEqual({
          'items.0': 'This item is not part of the order.',
          'items.2': 'This item is listed twice.',
        });
      });
    });

    describe('two people booking at once', () => {
      it('books one parcel, not two', async () => {
        const o = await s.paidOrder();
        const before = s.sr.ordersCreated;
        const results = await Promise.allSettled([create(o.id), create(o.id)]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.find(
          (r) => r.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(['SHIPMENT_IN_PROGRESS', 'SHIPMENT_ITEMS_INVALID']).toContain(
          (lost.reason as AppException).code,
        );
        expect(s.sr.ordersCreated).toBe(before + 1);
        expect(
          await s.one<number>(
            `select count(*)::int as v from shipments where order_id = $1 and status <> 'failed'`,
            [o.id],
          ),
        ).toBe(1);
      });
    });

    describe('cancelling a shipment', () => {
      it('cancels with the carrier before pickup, frees the items and leaves the order ready for another parcel', async () => {
        const o = await s.paidOrder();
        const sh = await create(o.id);
        const done = await s.shipments.cancel(s.owner(), sh.id);
        expect(done.status).toBe('cancelled');
        expect(s.sr.cancelled).toContain(sh.awb);
        expect(await s.fulfillment(o.id)).toBe('unfulfilled');
        expect(await s.orderStatus(o.id)).toBe('ready_to_ship');
        expect(done.events.map((e) => e.status).sort()).toEqual([
          'cancelled',
          'created',
        ]);
        expect((await failure(s.shipments.cancel(s.owner(), sh.id))).code).toBe(
          'SHIPMENT_NOT_CANCELLABLE',
        );
        expect((await create(o.id)).status).toBe('created');
      });

      it('does not record a cancellation the carrier did not accept', async () => {
        const o = await s.paidOrder();
        const sh = await create(o.id);
        s.sr.failCancel.push({
          status: 422,
          body: { message: 'Shipment already picked up' },
        });
        expect((await failure(s.shipments.cancel(s.owner(), sh.id))).code).toBe(
          'CARRIER_REJECTED',
        );
        expect(await s.shipmentRow(sh.id)).toMatchObject({ status: 'created' });
        s.sr.failCancel.push({ networkError: true });
        expect((await failure(s.shipments.cancel(s.owner(), sh.id))).code).toBe(
          'CARRIER_UNAVAILABLE',
        );
        expect(await s.shipmentRow(sh.id)).toMatchObject({ status: 'created' });
      });

      it('cannot cancel a parcel the carrier already has', async () => {
        const o = await s.paidOrder();
        const sh = await create(o.id);
        s.sr.say(sh.awb!, 'Picked Up');
        await s.tracking.refresh(s.w.tenantA, sh.id, 'owner');
        const e = await failure(s.shipments.cancel(s.owner(), sh.id));
        expect(e.code).toBe('SHIPMENT_NOT_CANCELLABLE');
        expect(e.message).toMatch(/already has this parcel/);
      });
    });

    describe('orders follow their shipments', () => {
      it('cannot be cancelled or moved by hand while a shipment is in progress', async () => {
        const o = await s.paidOrder();
        const sh = await create(o.id);
        const cancelOrder = (
          await import('../src/modules/orders/orders.service.js')
        ).OrdersService;
        const orders = new cancelOrder(s.t.service);
        expect(
          (
            await failure(
              orders.cancel(s.owner(), o.id, {
                reason: 'changed my mind',
              } as never),
            )
          ).code,
        ).toBe('ORDER_HAS_SHIPMENT');
        expect(
          (
            await failure(
              orders.updateStatus(s.owner(), o.id, {
                status: 'shipped',
              } as never),
            )
          ).code,
        ).toBe('ORDER_HAS_SHIPMENT');
        expect(await s.orderStatus(o.id)).toBe('ready_to_ship');

        await s.shipments.cancel(s.owner(), sh.id);
        // With the parcel cancelled the Owner is in charge of the order again.
        expect(
          (
            await orders.updateStatus(s.owner(), o.id, {
              status: 'shipped',
            } as never)
          ).status,
        ).toBe('shipped');
      });

      it('also guards a cash-on-delivery order from being cancelled under its parcel', async () => {
        const o = await s.codOrder();
        const sh = await create(o.id);
        const { OrdersService } =
          await import('../src/modules/orders/orders.service.js');
        const orders = new OrdersService(s.t.service);
        expect(
          (
            await failure(
              orders.cancel(s.owner(), o.id, { reason: 'x' } as never),
            )
          ).code,
        ).toBe('ORDER_HAS_SHIPMENT');
        await s.shipments.cancel(s.owner(), sh.id);
        expect(
          (
            await orders.cancel(s.owner(), o.id, {
              reason: 'customer asked',
            } as never)
          ).status,
        ).toBe('cancelled');
      });
    });

    describe('isolation between organizations', () => {
      it('shows, cancels and refreshes nothing of another organization’s shipments', async () => {
        const o = await s.paidOrder();
        const mine = await create(o.id);
        expect(
          (
            await s.shipments.list(s.ownerB(), {
              page: 1,
              limit: 20,
              sortOrder: 'desc',
            } as never)
          ).items,
        ).toHaveLength(0);
        expect((await failure(s.shipments.get(s.ownerB(), mine.id))).code).toBe(
          'SHIPMENT_NOT_FOUND',
        );
        expect(
          (await failure(s.shipments.cancel(s.ownerB(), mine.id))).code,
        ).toBe('SHIPMENT_NOT_FOUND');
        expect(
          (await failure(s.shipments.retry(s.ownerB(), mine.id))).code,
        ).toBe('SHIPMENT_NOT_FOUND');
        expect(
          (await failure(s.shipments.label(s.ownerB(), mine.id))).code,
        ).toBe('SHIPMENT_NOT_FOUND');
        expect(
          (await failure(s.tracking.refresh(s.w.tenantB, mine.id, 'owner')))
            .code,
        ).toBe('SHIPMENT_NOT_FOUND');
        expect(
          (await failure(s.shipments.listForOrder(s.ownerB(), o.id))).code,
        ).toBe('ORDER_NOT_FOUND');
        expect(
          (await failure(s.shipments.create(s.ownerB(), o.id, {} as never)))
            .code,
        ).toBe('ORDER_NOT_FOUND');
      });

      it('is enforced by the database: a signed-in member reads shipments only with orders access, and only their own organization’s', async () => {
        const count = (userId: string) =>
          asUser(
            s.t,
            userId,
            async (tx) =>
              rowsOf<{ n: number }>(
                await tx.execute(
                  sql`select count(*)::int as n from public.shipments`,
                ),
              )[0].n,
          );
        expect(await count(s.w.members.reader)).toBeGreaterThan(0);
        expect(await count(s.w.members.nothing)).toBe(0); // no access to orders
        expect(await count(s.w.bob)).toBe(0); // another organization
        // Nobody signed in can change or remove a shipment: only the API (through the pinned role) writes them.
        await expect(
          asUser(s.t, s.w.alice, (tx) =>
            tx.execute(sql`update public.shipments set status = 'delivered'`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(s.t, s.w.alice, (tx) =>
            tx.execute(sql`delete from public.shipments`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(s.t, s.w.alice, (tx) =>
            tx.execute(sql`select content from public.shipment_labels`),
          ),
        ).rejects.toThrow();
      });
    });

    describe('carrier connections', () => {
      it('cannot be disconnected while parcels are with the carrier, but can be switched off', async () => {
        const carriers = new CarriersService(s.t.service, s.registry);
        const e = await failure(carriers.disconnect(s.owner(), 'shiprocket'));
        expect(e.code).toBe('CARRIER_IN_USE');
        expect(e.message).toMatch(/still with this carrier/);
        await carriers.setEnabled(s.owner(), 'shiprocket', { enabled: false });
        await carriers.setEnabled(s.owner(), 'shiprocket', { enabled: true });
      });
    });
  },
);
