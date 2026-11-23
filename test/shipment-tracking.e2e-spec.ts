import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { migrationsAvailable } from './support/pglite.js';
import {
  SR,
  createShipmentsWorld,
  type ShipmentsWorld,
} from './support/shipments-world.js';
import { DL_CREDS, orderTo } from './support/shipping-world.js';

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const TRACK = new RegExp(`^${SR}/courier/track/awb/`);

describe.skipIf(!migrationsAvailable)(
  'shipment tracking: refresh, webhooks, the scheduled sync, labels and the shopper’s view',
  () => {
    let s: ShipmentsWorld;
    const book = async (slug = 'sh-mug', qty = 1) => {
      const order = await s.paidOrder(slug, qty);
      const sh = await s.shipments.create(s.owner(), order.id, {
        providerCode: 'shiprocket',
      } as never);
      return { order, sh, awb: sh.awb! };
    };
    const refresh = (id: string) =>
      s.tracking.refresh(s.w.tenantA, id, 'owner');
    const stale = (id: string) =>
      s.t.asOwner((pg) =>
        pg.query(
          `update shipments set last_synced_at = now() - interval '2 hours' where id = $1`,
          [id],
        ),
      );
    const row = (id: string) => s.shipmentRow(id);

    beforeAll(async () => {
      s = await createShipmentsWorld();
    });
    afterAll(() => s.t.close());

    describe('refreshing a parcel', () => {
      it('follows the parcel to the door, and the order follows the parcel', async () => {
        const { order, sh, awb } = await book();
        expect(await s.orderStatus(order.id)).toBe('ready_to_ship');

        s.sr.say(awb, 'Picked Up');
        expect(await refresh(sh.id)).toEqual({ changed: true });
        expect(await row(sh.id)).toMatchObject({ status: 'picked_up' });
        expect((await row(sh.id)).picked_up_at).toBeTruthy();
        expect(await s.orderStatus(order.id)).toBe('shipped');

        s.sr.say(awb, 'In Transit', 'Shipment in transit');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'in_transit' });
        expect(await s.orderStatus(order.id)).toBe('shipped');

        s.sr.say(awb, 'Out For Delivery');
        await refresh(sh.id);
        expect(await s.orderStatus(order.id)).toBe('out_for_delivery');

        s.sr.say(awb, 'Delivered');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'delivered' });
        expect((await row(sh.id)).delivered_at).toBeTruthy();
        expect(await s.orderStatus(order.id)).toBe('delivered');

        // Every stage the order really went through is in its history, done by the carrier (the Owner did the booking).
        const h = await s.history(order.id);
        for (const step of [
          'shipped:carrier',
          'out_for_delivery:carrier',
          'delivered:carrier',
        ])
          expect(h).toContain(step);
        expect(await s.fulfillment(order.id)).toBe('fulfilled');
      });

      it('records each tracking update once, however often it is seen', async () => {
        const { sh, awb } = await book();
        s.sr.say(awb, 'In Transit', 'Arrived at hub');
        await refresh(sh.id);
        const count = await s.eventCount(sh.id);
        expect(await refresh(sh.id)).toEqual({ changed: false });
        await refresh(sh.id);
        expect(await s.eventCount(sh.id)).toBe(count);
        const detail = await s.shipments.get(s.owner(), sh.id);
        expect(detail.trackingUrl).toBe(`https://track.shiprocket.test/${awb}`);
        expect(detail.estimatedDelivery).toBeInstanceOf(Date);
        expect(detail.lastSyncedAt).toBeInstanceOf(Date);
        expect(
          detail.events.find((e) => e.description === 'Arrived at hub'),
        ).toMatchObject({
          status: 'in_transit',
          source: 'carrier_api',
        });
      });

      it('never takes a parcel backwards, and a delivered parcel is not asked about again', async () => {
        const { sh, awb } = await book();
        s.sr.say(awb, 'In Transit');
        await refresh(sh.id);
        s.sr.say(awb, 'Picked Up', 'Picked up late report');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'in_transit' });

        s.sr.say(awb, 'Delivered');
        await refresh(sh.id);
        const asked = s.carrier.to(TRACK).length;
        expect(await refresh(sh.id)).toEqual({ changed: false });
        expect(s.carrier.to(TRACK).length).toBe(asked);
      });

      it('handles a failed delivery attempt and a second try', async () => {
        const { order, sh, awb } = await book();
        s.sr.say(awb, 'Out For Delivery');
        await refresh(sh.id);
        s.sr.say(
          awb,
          'Delivery Attempt Failed',
          'Delivery attempt failed: customer unavailable',
        );
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'undelivered' });
        expect(await s.orderStatus(order.id)).toBe('out_for_delivery'); // never goes back
        s.sr.say(awb, 'Out For Delivery', 'Out for delivery again');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'out_for_delivery' });
      });

      it('follows a parcel that comes back to the seller', async () => {
        const { order, sh, awb } = await book();
        s.sr.say(awb, 'In Transit');
        await refresh(sh.id);
        s.sr.say(awb, 'RTO Initiated');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'returning' });
        expect(await s.orderStatus(order.id)).toBe('shipped');
        s.sr.say(awb, 'RTO Delivered');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'returned' });
        expect(await s.orderStatus(order.id)).toBe('returned');
        expect(await s.fulfillment(order.id)).toBe('returned');
      });

      it('does not treat cash on delivery as collected just because the parcel arrived', async () => {
        const cod = await s.codOrder();
        const sh = await s.shipments.create(s.owner(), cod.id, {
          providerCode: 'shiprocket',
        } as never);
        s.sr.say(sh.awb!, 'Delivered');
        await refresh(sh.id);
        expect(await s.orderStatus(cod.id)).toBe('delivered');
        expect(
          await s.one<string>(
            'select payment_status as v from orders where id = $1',
            [cod.id],
          ),
        ).toBe('pending_collection');
      });

      it('lets an order delivered in parts finish only when every part has arrived', async () => {
        const order = await s.paidOrder('sh-mug', 2);
        const item = await s.one<string>(
          'select id as v from order_items where order_id = $1',
          [order.id],
        );
        const a = await s.shipments.create(s.owner(), order.id, {
          providerCode: 'shiprocket',
          items: [{ orderItemId: item, quantity: 1 }],
        } as never);
        const b = await s.shipments.create(s.owner(), order.id, {
          providerCode: 'shiprocket',
        } as never);
        s.sr.say(a.awb!, 'Delivered');
        await refresh(a.id);
        expect(await s.orderStatus(order.id)).toBe('shipped'); // the second part has not left yet
        s.sr.say(b.awb!, 'Delivered');
        await refresh(b.id);
        expect(await s.orderStatus(order.id)).toBe('delivered');
      });

      it('records a cancellation made on the carrier’s side', async () => {
        const { order, sh, awb } = await book();
        s.sr.say(awb, 'Cancelled', 'Shipment cancelled by seller');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'cancelled' });
        expect(await s.fulfillment(order.id)).toBe('unfulfilled');
      });
    });

    describe('when the carrier cannot be asked', () => {
      it('says so safely, keeps the parcel as it was, and clears the note once the carrier answers', async () => {
        const { sh, awb } = await book();
        for (let i = 0; i < 6; i++) s.sr.failTrack.push({ networkError: true });
        const e = await failure(refresh(sh.id));
        s.sr.failTrack.length = 0;
        expect(e).toMatchObject({
          kind: 'UNAVAILABLE',
          code: 'CARRIER_UNAVAILABLE',
        });
        expect(await row(sh.id)).toMatchObject({ status: 'created' });
        expect(String((await row(sh.id)).failure_reason)).not.toBe('null');
        expect((await row(sh.id)).failure_reason).toBeTruthy();

        s.sr.say(awb, 'In Transit');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({
          status: 'in_transit',
          failure_reason: null,
        });
      });

      it('reports a carrier that does not know the waybill', async () => {
        const { sh, awb } = await book();
        s.sr.tracks.delete(awb);
        expect((await failure(refresh(sh.id))).code).toBe('CARRIER_REJECTED');
      });

      it('still tracks after the carrier is switched off for new bookings', async () => {
        const { sh, awb } = await book();
        await s.carriers.setEnabled(s.owner(), 'shiprocket', {
          enabled: false,
        });
        s.sr.say(awb, 'In Transit');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'in_transit' });
        await s.carriers.setEnabled(s.owner(), 'shiprocket', { enabled: true });
      });
    });

    describe('carrier webhooks', () => {
      it('use the webhook only to find the parcel: what it claims is never believed', async () => {
        const { order, sh, awb } = await book();
        s.sr.say(awb, 'In Transit');
        await stale(sh.id);
        await s.tracking.handleWebhook('shiprocket', {
          awb,
          current_status: 'DELIVERED', // a lie
          shipment_status: 'Delivered',
        });
        expect(await row(sh.id)).toMatchObject({ status: 'in_transit' });
        expect(await s.orderStatus(order.id)).toBe('shipped');

        s.sr.say(awb, 'Delivered');
        await stale(sh.id);
        await s.tracking.handleWebhook('shiprocket', { awb });
        expect(await row(sh.id)).toMatchObject({ status: 'delivered' });
        expect(await s.orderStatus(order.id)).toBe('delivered');
        expect(
          (await s.shipments.get(s.owner(), sh.id)).events.some(
            (e) => e.source === 'carrier_webhook',
          ),
        ).toBe(true);
      });

      it('ask the carrier at most once in a few seconds, however often the webhook repeats', async () => {
        const { sh, awb } = await book();
        s.sr.say(awb, 'In Transit');
        await stale(sh.id);
        const before = s.carrier.to(TRACK).length;
        await s.tracking.handleWebhook('shiprocket', { awb });
        await s.tracking.handleWebhook('shiprocket', { awb });
        await s.tracking.handleWebhook('shiprocket', { awb });
        expect(s.carrier.to(TRACK).length).toBe(before + 1);
      });

      it('ignore unknown waybills, other carriers’ waybills, finished parcels and nonsense', async () => {
        const { sh, awb } = await book();
        await stale(sh.id);
        const before = s.carrier.to(TRACK).length;
        await s.tracking.handleWebhook('shiprocket', { awb: 'NOSUCHAWB99' });
        await s.tracking.handleWebhook('delhivery', { awb }); // this waybill belongs to Shiprocket
        await s.tracking.handleWebhook('shiprocket', 'not even an object');
        await s.tracking.handleWebhook('shiprocket', null);
        await s.tracking.handleWebhook('shiprocket', {
          awb: "x'; drop table shipments;--",
        });
        expect(s.carrier.to(TRACK).length).toBe(before);
        expect(
          await s.one<number>('select count(*)::int as v from shipments'),
        ).toBeGreaterThan(0);
      });

      it('never reveal or touch another organization’s parcels', async () => {
        const { sh, awb } = await book();
        await stale(sh.id);
        // Organization B has no carrier connected: a webhook can only ever act through the OWNING organization's own account.
        await s.tracking.handleWebhook('shiprocket', { awb });
        const used = s.carrier.to(TRACK).at(-1)!;
        expect(used.headers.get('authorization')).toBe('Bearer sr-token-1234');
        expect(
          await s.one<number>(
            'select count(*)::int as v from shipment_events e join shipments x on x.id = e.shipment_id where x.tenant_id <> $1',
            [s.w.tenantA],
          ),
        ).toBe(0);
      });
    });

    describe('the scheduled sync', () => {
      it('refreshes parcels whose last check is old, skips fresh ones, and carries on past a failure', async () => {
        await s.t.asOwner((pg) =>
          pg.query(
            `update shipments set last_synced_at = now() where status in ('created','picked_up','in_transit','out_for_delivery','undelivered','returning')`,
          ),
        );
        const a = await book();
        const b = await book();
        const c = await book();
        const fresh = await book();
        await refresh(fresh.sh.id); // checked just now
        for (const x of [a, b, c]) await stale(x.sh.id);
        s.sr.say(a.awb, 'In Transit');
        s.sr.say(c.awb, 'Delivered');
        // The carrier fails on its first answer (whichever parcel that is); the others are still checked.
        s.sr.failTrack.push({ status: 400, body: { message: 'bad request' } });
        const result = await s.tracking.syncDue();
        expect(result.tenants).toBe(1);
        expect(result.shipments).toBe(3);
        expect(result.failed).toBe(1);
        expect(result.updated).toBeGreaterThanOrEqual(1);
        // The failed one is simply picked up by the next run.
        const next = await s.tracking.syncDue();
        expect(next.shipments).toBe(1);
        expect(next.failed).toBe(0);
        expect((await row(fresh.sh.id)).status).toBe('created');
      });

      it('has nothing to do when nothing is due', async () => {
        expect(await s.tracking.syncDue()).toEqual({
          tenants: 0,
          shipments: 0,
          updated: 0,
          failed: 0,
        });
      });
    });

    describe('labels', () => {
      it('keeps the carrier’s label link, and stores a PDF the carrier returns', async () => {
        const { sh } = await book();
        expect(sh.labelUrl).toBe('https://labels.shiprocket.test/label.pdf');
        expect(await s.shipments.label(s.owner(), sh.id)).toEqual({
          available: true,
          url: 'https://labels.shiprocket.test/label.pdf',
          stored: false,
        });
        expect(
          (await failure(s.shipments.labelFile(s.owner(), sh.id))).code,
        ).toBe('LABEL_NOT_FOUND');

        const provider = s.registry.get('shiprocket');
        const spy = vi
          .spyOn(provider, 'generateShippingLabel')
          .mockResolvedValue({
            pdfBase64: Buffer.from('%PDF-1.4 label bytes').toString('base64'),
          });
        const made = await s.shipments.generateLabel(s.owner(), sh.id);
        expect(made).toMatchObject({ available: true, stored: true });
        expect(
          (await s.shipments.labelFile(s.owner(), sh.id)).toString('latin1'),
        ).toBe('%PDF-1.4 label bytes');
        // Another organization cannot fetch it.
        expect(
          (await failure(s.shipments.labelFile(s.ownerB(), sh.id))).code,
        ).toBe('LABEL_NOT_FOUND');
        spy.mockRestore();
      });

      it('refuses anything that is not a PDF or an https link, and says the label is not ready', async () => {
        const { sh } = await book();
        const provider = s.registry.get('shiprocket');
        const spy = vi
          .spyOn(provider, 'generateShippingLabel')
          .mockResolvedValue({
            pdfBase64: Buffer.from('<html>not a pdf</html>').toString('base64'),
            url: 'http://insecure.test/x.pdf',
          });
        const e = await failure(s.shipments.generateLabel(s.owner(), sh.id));
        expect(e).toMatchObject({
          kind: 'UNAVAILABLE',
          code: 'LABEL_NOT_READY',
        });
        expect((await s.shipments.label(s.owner(), sh.id)).stored).toBe(false);
        spy.mockRestore();
      });

      it('only makes labels for parcels that are still on their way', async () => {
        const { sh, awb } = await book();
        s.sr.say(awb, 'Delivered');
        await refresh(sh.id);
        expect(
          (await failure(s.shipments.generateLabel(s.owner(), sh.id))).code,
        ).toBe('SHIPMENT_NO_LABEL');
      });
    });

    describe('what the shopper sees', () => {
      it('shows where the parcel is and nothing about how it was booked', async () => {
        const placed = await s.checkout.placeOrder(
          'alpha-shop',
          orderTo('sh-mug', 1, 'cod'),
          s.key(),
        );
        const orderId = (await s.one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [s.w.tenantA, placed.orderNumber],
        ))!;
        const view = () =>
          s.checkout.getOrder(
            'alpha-shop',
            placed.orderNumber,
            placed.accessToken!,
          );
        expect((await view()).shipments).toEqual([]);

        const sh = await s.shipments.create(s.owner(), orderId, {
          providerCode: 'shiprocket',
        } as never);
        s.sr.say(sh.awb!, 'In Transit', 'Arrived at Pune hub');
        await refresh(sh.id);
        const seen = (await view()).shipments;
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          status: 'in_transit',
          courierName: 'Xpressbees Surface',
          awb: sh.awb,
          trackingUrl: `https://track.shiprocket.test/${sh.awb}`,
          items: [{ name: 'sh-mug', quantity: 1 }],
        });
        expect(
          seen[0].events.find((e) => e.description === 'Arrived at Pune hub'),
        ).toMatchObject({ location: 'Hub', status: 'in_transit' });
        expect(Object.keys(seen[0]).sort()).toEqual([
          'awb',
          'courierName',
          'estimatedDelivery',
          'events',
          'items',
          'status',
          'trackingUrl',
        ]);
        expect(JSON.stringify(seen)).not.toMatch(
          /providerCode|shiprocket"|failureReason|codAmount|attempts|tenant/i,
        );
        expect((await view()).status).toBe('shipped');
      });

      it('does not show a parcel that was cancelled or is still being booked', async () => {
        const placed = await s.checkout.placeOrder(
          'alpha-shop',
          orderTo('sh-mug', 1, 'cod'),
          s.key(),
        );
        const orderId = (await s.one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [s.w.tenantA, placed.orderNumber],
        ))!;
        s.sr.failCreate.push({ networkError: true });
        await failure(
          s.shipments.create(s.owner(), orderId, {
            providerCode: 'shiprocket',
          } as never),
        );
        const view = () =>
          s.checkout.getOrder(
            'alpha-shop',
            placed.orderNumber,
            placed.accessToken!,
          );
        expect((await view()).shipments).toEqual([]);
        const pending = (await s.shipments.listForOrder(s.owner(), orderId))[0];
        const booked = await s.shipments.retry(s.owner(), pending.id);
        expect((await view()).shipments).toHaveLength(1);
        await s.shipments.cancel(s.owner(), booked.id);
        expect((await view()).shipments).toEqual([]);
      });
    });

    describe('another carrier: Delhivery', () => {
      it('books and tracks through the same flow with no carrier-specific code outside its adapter', async () => {
        const made: string[] = [];
        s.carrier.on('POST', '/api/cmu/create.json', (req) => {
          made.push(String(req.form?.get('data')));
          return {
            body: {
              packages: [
                { status: 'Success', waybill: 'DLAWB555001', refnum: 'x' },
              ],
            },
          };
        });
        s.carrier.on('GET', '/api/v1/packages/json/', {
          body: {
            ShipmentData: [
              {
                Shipment: {
                  Status: { Status: 'In Transit', StatusType: 'UD' },
                  Scans: [
                    {
                      ScanDetail: {
                        ScanDateTime: '2026-02-02T10:00:00',
                        Scan: 'In Transit',
                        Instructions: 'Arrived at hub',
                        ScannedLocation: 'Pune',
                      },
                    },
                  ],
                  ExpectedDeliveryDate: '2026-02-06T00:00:00',
                },
              },
            ],
          },
        });
        s.carrier.on('GET', '/api/p/packing_slip', {
          body: {
            packages: [
              { pdf_download_link: 'https://labels.delhivery.test/x.pdf' },
            ],
          },
        });
        await s.connect('delhivery');

        const o = await s.paidOrder('sh-lamp', 1);
        const sh = await s.shipments.create(s.owner(), o.id, {
          providerCode: 'delhivery',
        } as never);
        expect(sh).toMatchObject({
          providerCode: 'delhivery',
          awb: 'DLAWB555001',
          paymentMode: 'prepaid',
          status: 'created',
        });
        expect(JSON.parse(made[0]).shipments[0]).toMatchObject({
          payment_mode: 'Prepaid',
          pin: '560001',
          weight: 1500,
        });
        expect(sh.labelUrl).toBe('https://labels.delhivery.test/x.pdf');
        await refresh(sh.id);
        expect(await row(sh.id)).toMatchObject({ status: 'in_transit' });
        expect(await s.orderStatus(o.id)).toBe('shipped');
        // Credentials are used only for this organization's own account.
        expect(
          s.carrier
            .to('/api/cmu/create.json')
            .at(-1)!
            .headers.get('authorization'),
        ).toBe(`Token ${DL_CREDS.apiToken}`);
      });
    });
  },
);
