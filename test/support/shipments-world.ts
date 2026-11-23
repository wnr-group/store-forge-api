import { ShipmentCarrier } from '../../src/modules/shipments/shipment-carrier.js';
import { ShipmentTrackingService } from '../../src/modules/shipments/shipment-tracking.service.js';
import { ShipmentsService } from '../../src/modules/shipments/shipments.service.js';
import { FakeCarrier, type FakeAnswer } from './fake-carrier.js';
import {
  createShippingWorld,
  ORIGIN,
  orderTo,
  type ShippingWorld,
} from './shipping-world.js';

/** What the fake Shiprocket says about a waybill. `null` means "no such shipment". */
export interface FakeTrack {
  current: string;
  activities: { date: string; activity: string; location: string }[];
  etd?: string;
}

export const SR = '/v1/external';

/** Registers the booking, label, cancel and tracking routes of the fake Shiprocket. */
export function addShiprocketShipping(carrier: FakeCarrier) {
  const state = {
    ordersCreated: 0,
    awbs: 0,
    /** order reference -> ids, so a repeated create (a resume) is recognisable. */
    byReference: new Map<string, { orderId: number; shipmentId: number }>(),
    /** waybill -> what tracking says. */
    tracks: new Map<string, FakeTrack>(),
    cancelled: [] as string[],
    /** Answers to give, once each, before the normal behaviour (to script failures). */
    failCreate: [] as FakeAnswer[],
    failAssign: [] as FakeAnswer[],
    failTrack: [] as FakeAnswer[],
    failCancel: [] as FakeAnswer[],
    labelAnswer: null as FakeAnswer | null,
  };

  carrier.on('POST', `${SR}/orders/create/adhoc`, (req) => {
    const scripted = state.failCreate.shift();
    if (scripted) return scripted;
    const body = req.json as { order_id: string };
    let ids = state.byReference.get(body.order_id);
    if (!ids) {
      state.ordersCreated += 1;
      ids = {
        orderId: 5000 + state.ordersCreated,
        shipmentId: 7000 + state.ordersCreated,
      };
      state.byReference.set(body.order_id, ids);
    }
    return {
      body: {
        order_id: ids.orderId,
        shipment_id: ids.shipmentId,
        status: 'NEW',
      },
    };
  });
  carrier.on('POST', `${SR}/courier/assign/awb`, () => {
    const scripted = state.failAssign.shift();
    if (scripted) return scripted;
    state.awbs += 1;
    const awb = `SRAWB${String(100000 + state.awbs)}`;
    state.tracks.set(awb, {
      current: 'Pickup Scheduled',
      activities: [
        {
          date: '2026-02-01 09:00:00',
          activity: 'Pickup Scheduled',
          location: 'Bengaluru',
        },
      ],
    });
    return {
      body: {
        awb_assign_status: 1,
        response: {
          data: {
            awb_code: awb,
            courier_name: 'Xpressbees Surface',
            courier_company_id: 10,
          },
        },
      },
    };
  });
  carrier.on(
    'POST',
    `${SR}/courier/generate/label`,
    () =>
      state.labelAnswer ?? {
        body: {
          label_created: 1,
          label_url: 'https://labels.shiprocket.test/label.pdf',
        },
      },
  );
  carrier.on('POST', `${SR}/orders/cancel/shipment/awbs`, (req) => {
    const scripted = state.failCancel.shift();
    if (scripted) return scripted;
    state.cancelled.push(...((req.json as { awbs: string[] }).awbs ?? []));
    return { body: { message: 'Shipment cancelled' } };
  });
  carrier.on('GET', new RegExp(`^${SR}/courier/track/awb/`), (req) => {
    const scripted = state.failTrack.shift();
    if (scripted) return scripted;
    const awb = decodeURIComponent(req.url.pathname.split('/').pop() ?? '');
    const t = state.tracks.get(awb);
    if (!t) return { status: 404, body: { message: 'not found' } };
    return {
      body: {
        tracking_data: {
          shipment_track: [{ current_status: t.current }],
          shipment_track_activities: t.activities.map((a) => ({
            date: a.date,
            activity: a.activity,
            location: a.location,
          })),
          track_url: `https://track.shiprocket.test/${awb}`,
          etd: t.etd ?? '2026-02-05 18:00:00',
        },
      },
    };
  });

  return Object.assign(state, {
    /** Move a parcel along: what the carrier will say from now on. */
    say(
      awb: string,
      current: string,
      activity = current,
      at = '2026-02-02 10:00:00',
    ) {
      const t = state.tracks.get(awb);
      if (!t) throw new Error(`no such waybill ${awb}`);
      t.current = current;
      t.activities.unshift({ date: at, activity, location: 'Hub' });
    },
  });
}

/**
 * The shipping world plus shipments: carrier "Shiprocket" connected and checked for organization A with a pickup address, cash on
 * delivery switched on, and a few products with weights.
 */
export async function createShipmentsWorld() {
  const s = await createShippingWorld();
  const sr = addShiprocketShipping(s.carrier);
  const shipCarrier = new ShipmentCarrier(s.t.service, s.registry);
  const shipments = new ShipmentsService(s.t.service, shipCarrier, s.selection);
  const tracking = new ShipmentTrackingService(s.t.service, shipCarrier);

  await s.cod.save(s.owner(), {
    enabled: true,
    minOrderMinor: 0,
    maxOrderMinor: null,
    feeMinor: 0,
  });
  await s.tools.saveOrigin(s.owner(), ORIGIN as never);
  await s.connect('shiprocket');
  await s.product(s.w.tenantA, 'sh-mug', 1000, 50000, 400);
  await s.product(s.w.tenantA, 'sh-lamp', 1000, 120000, 1500);
  await s.product(s.w.tenantA, 'sh-noweight', 1000, 10000, 0);

  /** Places a cash-on-delivery order for A (confirmed at once) and returns its id and number. */
  async function codOrder(slug = 'sh-mug', quantity = 1) {
    const placed = await s.checkout.placeOrder(
      'alpha-shop',
      orderTo(slug, quantity, 'cod'),
      s.key(),
    );
    const id = (await s.one<string>(
      'select id as v from orders where tenant_id = $1 and order_number = $2',
      [s.w.tenantA, placed.orderNumber],
    ))!;
    return { id, number: placed.orderNumber, total: placed.totalMinor };
  }

  /** Places an order and makes it a paid online order (as a captured Razorpay payment would have). */
  async function paidOrder(slug = 'sh-mug', quantity = 1) {
    const o = await codOrder(slug, quantity);
    await s.t.asOwner((pg) =>
      pg.query(
        `update orders set payment_method = 'razorpay', payment_status = 'paid', status = 'confirmed' where id = $1`,
        [o.id],
      ),
    );
    return o;
  }

  const orderStatus = (id: string) =>
    s.one<string>('select status as v from orders where id = $1', [id]);
  const fulfillment = (id: string) =>
    s.one<string>('select fulfillment_status as v from orders where id = $1', [
      id,
    ]);
  const history = async (id: string) =>
    (
      await s.t.asOwner(
        async (pg) =>
          (
            await pg.query<{ to_status: string; actor_type: string }>(
              'select to_status, actor_type from order_status_history where order_id = $1 order by created_at, id',
              [id],
            )
          ).rows,
      )
    ).map((r) => `${r.to_status}:${r.actor_type}`);

  return {
    ...s,
    sr,
    shipments,
    tracking,
    shipCarrier,
    codOrder,
    paidOrder,
    orderStatus,
    fulfillment,
    history,
    shipmentRow: (id: string) =>
      s.t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              'select * from shipments where id = $1',
              [id],
            )
          ).rows[0],
      ),
    eventCount: (id: string) =>
      s.one<number>(
        'select count(*)::int as v from shipment_events where shipment_id = $1',
        [id],
      ),
  };
}

export type ShipmentsWorld = Awaited<ReturnType<typeof createShipmentsWorld>>;
export type { ShippingWorld };
