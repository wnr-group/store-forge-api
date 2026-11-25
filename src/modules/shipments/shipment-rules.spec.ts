import { describe, expect, it } from 'vitest';
import {
  allocateItems,
  awbsInPayload,
  canMoveShipment,
  carriesWholeOrder,
  eventKey,
  fulfillmentStatusFor,
  itemsValue,
  itemsWeight,
  orderStatusFor,
  orderSteps,
  safeUrl,
  shipmentStatusOf,
  type OrderLine,
} from './shipment-rules.js';

const line = (
  id: string,
  quantity: number,
  shipped = 0,
  weight = 100,
  total = quantity * 1000,
): OrderLine => ({
  id,
  name: `Item ${id}`,
  quantity,
  shipped,
  weightGrams: weight,
  totalMinor: total,
});

describe('tracking status mapping and movement', () => {
  it('maps what carriers say and ignores what tells us nothing', () => {
    expect(shipmentStatusOf('delivered')).toBe('delivered');
    expect(shipmentStatusOf('returning')).toBe('returning');
    expect(shipmentStatusOf('pending')).toBeNull();
    expect(shipmentStatusOf('unknown')).toBeNull();
  });

  it('only moves forward, and never out of a final status', () => {
    expect(canMoveShipment('created', 'picked_up')).toBe(true);
    expect(canMoveShipment('in_transit', 'picked_up')).toBe(false);
    expect(canMoveShipment('delivered', 'in_transit')).toBe(false);
    expect(canMoveShipment('delivered', 'returned')).toBe(false);
    expect(canMoveShipment('returning', 'delivered')).toBe(false);
    expect(canMoveShipment('returning', 'returned')).toBe(true);
    expect(canMoveShipment('undelivered', 'out_for_delivery')).toBe(true); // a second attempt
    expect(canMoveShipment('in_transit', 'cancelled')).toBe(false); // once with the carrier, it is no longer cancellable
    expect(canMoveShipment('created', 'created')).toBe(false);
    expect(canMoveShipment('creating', 'picked_up')).toBe(false);
  });
});

describe('the order follows its shipments', () => {
  const st = (...s: string[]) => s.map((status) => ({ status })) as never;

  it('is ready to ship once booked, shipped once the carrier has it', () => {
    expect(orderStatusFor(st('created'), true)).toBe('ready_to_ship');
    expect(orderStatusFor(st('picked_up'), true)).toBe('shipped');
    expect(orderStatusFor(st('in_transit'), true)).toBe('shipped');
    expect(orderStatusFor(st('undelivered'), true)).toBe('shipped');
  });

  it('is out for delivery or delivered only when every item is on a shipment that is', () => {
    expect(orderStatusFor(st('out_for_delivery'), true)).toBe(
      'out_for_delivery',
    );
    expect(orderStatusFor(st('out_for_delivery'), false)).toBe('shipped');
    expect(orderStatusFor(st('delivered'), true)).toBe('delivered');
    expect(orderStatusFor(st('delivered'), false)).toBe('shipped');
    expect(orderStatusFor(st('delivered', 'in_transit'), true)).toBe('shipped');
    expect(orderStatusFor(st('delivered', 'out_for_delivery'), true)).toBe(
      'out_for_delivery',
    );
  });

  it('is returned only when every live shipment came back', () => {
    expect(orderStatusFor(st('returned'), true)).toBe('returned');
    expect(orderStatusFor(st('returned', 'delivered'), true)).toBe('delivered');
    expect(orderStatusFor(st('returning'), true)).toBe('shipped');
  });

  it('ignores shipments that were cancelled, never booked or are still being booked', () => {
    expect(
      orderStatusFor(st('cancelled', 'failed', 'creating'), true),
    ).toBeNull();
    expect(orderStatusFor(st('cancelled', 'in_transit'), true)).toBe('shipped');
  });

  it('steps through every status in between, in order', () => {
    expect(orderSteps('confirmed', 'ready_to_ship')).toEqual([
      'processing',
      'ready_to_ship',
    ]);
    expect(orderSteps('processing', 'ready_to_ship')).toEqual([
      'ready_to_ship',
    ]);
    expect(orderSteps('ready_to_ship', 'shipped')).toEqual(['shipped']);
    expect(orderSteps('ready_to_ship', 'delivered')).toEqual([
      'shipped',
      'delivered',
    ]);
    expect(orderSteps('shipped', 'out_for_delivery')).toEqual([
      'out_for_delivery',
    ]);
    expect(orderSteps('out_for_delivery', 'delivered')).toEqual(['delivered']);
    expect(orderSteps('shipped', 'delivered')).toEqual(['delivered']);
    expect(orderSteps('ready_to_ship', 'returned')).toEqual([
      'shipped',
      'returned',
    ]);
    expect(orderSteps('delivered', 'returned')).toEqual(['returned']);
  });

  it('never goes backwards or touches final orders', () => {
    expect(orderSteps('shipped', 'ready_to_ship')).toEqual([]);
    expect(orderSteps('delivered', 'shipped')).toEqual([]);
    expect(orderSteps('delivered', 'out_for_delivery')).toEqual([]);
    expect(orderSteps('returned', 'returned')).toEqual([]);
    expect(orderSteps('cancelled', 'shipped')).toEqual([]);
    expect(orderSteps('shipped', 'shipped')).toEqual([]);
  });

  it('describes how much of the order has gone out', () => {
    expect(fulfillmentStatusFor(st('created'), true, true)).toBe('fulfilled');
    expect(fulfillmentStatusFor(st('created'), false, true)).toBe('partial');
    expect(fulfillmentStatusFor(st('cancelled'), false, false)).toBe(
      'unfulfilled',
    );
    expect(fulfillmentStatusFor(st('returned'), true, true)).toBe('returned');
  });
});

describe('choosing what goes in a parcel', () => {
  const lines = [line('a', 3), line('b', 1, 0, 500, 2500), line('c', 2, 2)];

  it('takes everything not yet shipped when nothing is named', () => {
    const r = allocateItems(lines);
    expect(r.errors).toEqual({});
    expect(r.lines.map((l) => [l.line.id, l.quantity])).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
    expect(itemsWeight(r.lines)).toBe(3 * 100 + 500);
    expect(itemsValue(r.lines)).toBe(3000 + 2500);
  });

  it('says so when nothing is left', () => {
    expect(allocateItems([line('c', 2, 2)]).errors.items).toMatch(
      /already on a shipment/,
    );
  });

  it('takes the named items and counts, and values a part by its share', () => {
    const r = allocateItems(lines, [{ orderItemId: 'a', quantity: 1 }]);
    expect(r.errors).toEqual({});
    expect(itemsValue(r.lines)).toBe(1000);
    expect(itemsWeight(r.lines)).toBe(100);
  });

  it('reports each problem against its entry', () => {
    const r = allocateItems(lines, [
      { orderItemId: 'a', quantity: 4 },
      { orderItemId: 'zzz', quantity: 1 },
      { orderItemId: 'c', quantity: 1 },
      { orderItemId: 'b', quantity: 1 },
      { orderItemId: 'b', quantity: 1 },
    ]);
    expect(r.errors).toEqual({
      'items.0': 'Only 3 of Item a are left to ship.',
      'items.1': 'This item is not part of the order.',
      'items.2': 'Item c is already fully shipped.',
      'items.4': 'This item is listed twice.',
    });
  });

  it('knows when a parcel is the whole order', () => {
    const whole = [line('a', 3), line('b', 1)];
    expect(carriesWholeOrder(whole, allocateItems(whole).lines)).toBe(true);
    expect(
      carriesWholeOrder(
        whole,
        allocateItems(whole, [{ orderItemId: 'a', quantity: 2 }]).lines,
      ),
    ).toBe(false);
    const half = [line('a', 3, 1), line('b', 1)];
    expect(carriesWholeOrder(half, allocateItems(half).lines)).toBe(false);
  });
});

describe('tracking history', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');

  it('fingerprints an event the same way however it arrives', () => {
    const a = eventKey({
      at,
      status: 'in_transit',
      description: 'Arrived at Hub ',
      location: 'Pune',
    });
    const b = eventKey({
      at,
      status: 'in_transit',
      description: 'arrived at hub',
      location: ' pune ',
    });
    expect(a).toBe(b);
    expect(
      eventKey({
        at,
        status: 'delivered',
        description: 'arrived at hub',
        location: 'pune',
      }),
    ).not.toBe(a);
    expect(
      eventKey({
        at: null,
        status: 'in_transit',
        description: 'x',
        location: null,
      }),
    ).toHaveLength(40);
  });

  it('only keeps https links', () => {
    expect(safeUrl('https://track.example.test/x?a=1')).toBe(
      'https://track.example.test/x?a=1',
    );
    expect(safeUrl('http://track.example.test/x')).toBeNull();
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });

  it('finds waybill numbers in the shapes carriers send, and nothing else', () => {
    expect(
      awbsInPayload({ awb: '123456789', current_status: 'DELIVERED' }),
    ).toEqual(['123456789']);
    expect(awbsInPayload({ Shipment: { AWB: 'ABC123456' } })).toEqual([
      'ABC123456',
    ]);
    expect(
      awbsInPayload({
        ShipmentData: [
          { Shipment: { Waybill: 4455667788 } },
          { waybill: 'XY-9988' },
        ],
      }),
    ).toEqual(['4455667788', 'XY-9988']);
    expect(awbsInPayload({ awb: 'has spaces and <script>' })).toEqual([]);
    expect(awbsInPayload('awb: 123456')).toEqual([]);
    expect(awbsInPayload(null)).toEqual([]);
    expect(awbsInPayload({ awb: 'x' })).toEqual([]);
  });
});
