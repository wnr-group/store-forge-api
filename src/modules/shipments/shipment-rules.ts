import { createHash } from 'node:crypto';
import type {
  OrderFulfillmentStatus,
  OrderStatus,
} from '../../database/schema/enums.js';
import {
  OPEN_SHIPMENT_STATUSES,
  type ShipmentStatus,
} from '../../database/schema/shipping.js';
import type {
  TrackingEvent,
  TrackingStatus,
} from '../shipping/providers/shipping-provider.js';

/**
 * The rules of shipments, kept free of the database and the carriers so they can be tested on their own.
 *
 * A shipment moves forward only: a late or repeated carrier update can never take a parcel back from "delivered" to "in
 * transit". The order follows its shipments (never the other way round), one status at a time, so the order's history shows
 * every step it really went through.
 */

const TERMINAL: readonly ShipmentStatus[] = [
  'delivered',
  'returned',
  'cancelled',
  'failed',
];

export const isOpenShipment = (status: ShipmentStatus): boolean =>
  (OPEN_SHIPMENT_STATUSES as readonly string[]).includes(status);

export const isTerminalShipment = (status: ShipmentStatus): boolean =>
  TERMINAL.includes(status);

/** What the carrier's tracking status means for our shipment, or null when it says nothing new (pending, unknown). */
export function shipmentStatusOf(
  tracking: TrackingStatus,
): ShipmentStatus | null {
  switch (tracking) {
    case 'picked_up':
    case 'in_transit':
    case 'out_for_delivery':
    case 'delivered':
    case 'undelivered':
    case 'returning':
    case 'returned':
    case 'cancelled':
      return tracking;
    default:
      return null;
  }
}

const FORWARD: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  creating: [],
  created: [
    'picked_up',
    'in_transit',
    'out_for_delivery',
    'undelivered',
    'returning',
    'delivered',
    'returned',
    'cancelled',
  ],
  picked_up: [
    'in_transit',
    'out_for_delivery',
    'undelivered',
    'returning',
    'delivered',
    'returned',
  ],
  in_transit: [
    'out_for_delivery',
    'undelivered',
    'returning',
    'delivered',
    'returned',
  ],
  out_for_delivery: [
    'in_transit',
    'undelivered',
    'returning',
    'delivered',
    'returned',
  ],
  undelivered: [
    'in_transit',
    'out_for_delivery',
    'returning',
    'delivered',
    'returned',
  ],
  returning: ['returned'],
  delivered: [],
  returned: [],
  cancelled: [],
  failed: [],
};

/** Whether tracking may move a shipment from one status to another. Staying where it is is never a move. */
export const canMoveShipment = (from: ShipmentStatus, to: ShipmentStatus) =>
  FORWARD[from].includes(to);

/** Statuses at which the carrier has the parcel in its hands. */
const WITH_CARRIER: readonly ShipmentStatus[] = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'undelivered',
  'returning',
  'delivered',
  'returned',
];
export const isWithCarrier = (status: ShipmentStatus) =>
  WITH_CARRIER.includes(status);

/** A shipment still holds on to its order items (they cannot be shipped again) unless it was cancelled or never booked. */
export const holdsItems = (status: ShipmentStatus) =>
  status !== 'cancelled' && status !== 'failed';

// --- The order follows its shipments -----------------------------------------------------------------------------------

export interface ShipmentLike {
  status: ShipmentStatus;
}

/**
 * The status the order should have, given its shipments. `fullyCovered` says every item of the order is on some shipment: until
 * then the order can be "shipped" at most, because part of it has not left yet.
 */
export function orderStatusFor(
  shipments: readonly ShipmentLike[],
  fullyCovered: boolean,
): OrderStatus | null {
  const live = shipments.filter(
    (s) =>
      s.status !== 'cancelled' &&
      s.status !== 'failed' &&
      s.status !== 'creating',
  );
  if (live.length === 0) return null;
  if (live.every((s) => s.status === 'returned')) return 'returned';
  // A parcel that came back no longer counts towards getting the order to the customer.
  const kept = live.filter((s) => s.status !== 'returned');
  if (fullyCovered && kept.every((s) => s.status === 'delivered'))
    return 'delivered';
  if (
    fullyCovered &&
    kept.every(
      (s) => s.status === 'delivered' || s.status === 'out_for_delivery',
    ) &&
    kept.some((s) => s.status === 'out_for_delivery')
  )
    return 'out_for_delivery';
  if (live.some((s) => isWithCarrier(s.status))) return 'shipped';
  return 'ready_to_ship';
}

const BASE_PATH: readonly OrderStatus[] = [
  'confirmed',
  'processing',
  'ready_to_ship',
  'shipped',
];

/** The statuses to pass through, in order, to take an order from `current` to `target` (empty when it is already there or past). */
export function orderSteps(
  current: OrderStatus,
  target: OrderStatus,
): OrderStatus[] {
  if (target === 'returned') {
    if (current === 'returned') return [];
    const i = BASE_PATH.indexOf(current);
    const toShipped = i >= 0 ? BASE_PATH.slice(i + 1) : [];
    return [...toShipped, 'returned'];
  }
  if (target === 'delivered' && current === 'out_for_delivery')
    return ['delivered'];
  const path: OrderStatus[] =
    target === 'delivered'
      ? [...BASE_PATH, 'delivered']
      : target === 'out_for_delivery'
        ? [...BASE_PATH, 'out_for_delivery']
        : BASE_PATH.slice(0, BASE_PATH.indexOf(target) + 1);
  const at = path.indexOf(current);
  return at < 0 ? [] : path.slice(at + 1);
}

export function fulfillmentStatusFor(
  shipments: readonly ShipmentLike[],
  fullyCovered: boolean,
  anyCovered: boolean,
): OrderFulfillmentStatus {
  const live = shipments.filter(
    (s) => s.status !== 'cancelled' && s.status !== 'failed',
  );
  if (live.length > 0 && live.every((s) => s.status === 'returned'))
    return 'returned';
  if (fullyCovered) return 'fulfilled';
  return anyCovered ? 'partial' : 'unfulfilled';
}

// --- Choosing what goes in a parcel ------------------------------------------------------------------------------------

export interface OrderLine {
  id: string;
  name: string;
  quantity: number;
  /** Already on a shipment that was not cancelled. */
  shipped: number;
  weightGrams: number;
  totalMinor: number;
}

export interface Requested {
  orderItemId: string;
  quantity: number;
}

export interface Allocation {
  lines: { line: OrderLine; quantity: number }[];
  errors: Record<string, string>;
}

/**
 * What goes in this parcel. With nothing requested it is everything not yet shipped. A request names order items and counts;
 * each must belong to the order, appear once and not exceed what is left. Problems come back per entry so the form can show them.
 */
export function allocateItems(
  lines: readonly OrderLine[],
  requested?: readonly Requested[],
): Allocation {
  const errors: Record<string, string> = {};
  const out: Allocation['lines'] = [];
  if (!requested || requested.length === 0) {
    for (const line of lines)
      if (line.quantity - line.shipped > 0)
        out.push({ line, quantity: line.quantity - line.shipped });
    if (out.length === 0)
      errors.items = 'Every item of this order is already on a shipment.';
    return { lines: out, errors };
  }
  const seen = new Set<string>();
  requested.forEach((r, i) => {
    const key = `items.${i}`;
    const line = lines.find((l) => l.id === r.orderItemId);
    if (!line) {
      errors[key] = 'This item is not part of the order.';
      return;
    }
    if (seen.has(r.orderItemId)) {
      errors[key] = 'This item is listed twice.';
      return;
    }
    seen.add(r.orderItemId);
    const left = line.quantity - line.shipped;
    if (left <= 0) errors[key] = `${line.name} is already fully shipped.`;
    else if (r.quantity > left)
      errors[key] =
        `Only ${left} of ${line.name} ${left === 1 ? 'is' : 'are'} left to ship.`;
    else out.push({ line, quantity: r.quantity });
  });
  return { lines: out, errors };
}

/** Weight of the chosen items, from the weights saved with the order. */
export const itemsWeight = (lines: Allocation['lines']): number =>
  lines.reduce((sum, l) => sum + l.line.weightGrams * l.quantity, 0);

/** Value of the chosen items (what the customer paid for them, before shipping and tax). */
export function itemsValue(lines: Allocation['lines']): number {
  let total = 0;
  for (const { line, quantity } of lines)
    total += Math.round((line.totalMinor * quantity) / line.quantity);
  return total;
}

/** True when this parcel carries every unit of every item of the order (and nothing was shipped before). */
export const carriesWholeOrder = (
  lines: readonly OrderLine[],
  chosen: Allocation['lines'],
): boolean =>
  lines.every((l) => l.shipped === 0) &&
  lines.every(
    (l) => chosen.find((c) => c.line.id === l.id)?.quantity === l.quantity,
  );

// --- Tracking history --------------------------------------------------------------------------------------------------

/** A fingerprint of one tracking event, so the same update arriving twice (webhook then sync, or a retry) is recorded once. */
export function eventKey(e: TrackingEvent): string {
  return createHash('sha1')
    .update(
      [
        e.at ? e.at.toISOString() : '',
        e.status,
        e.description.trim().toLowerCase(),
        (e.location ?? '').trim().toLowerCase(),
      ].join('|'),
    )
    .digest('hex');
}

/** Only an https link is ever shown to people or returned from a carrier answer. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The waybill numbers a carrier webhook talks about. The payload is only used to find them; its status is never trusted. */
export function awbsInPayload(body: unknown): string[] {
  const found = new Set<string>();
  const keys = new Set([
    'awb',
    'awb_code',
    'awbcode',
    'waybill',
    'waybillno',
    'waybill_no',
    'awbno',
    'awb_no',
  ]);
  const walk = (value: unknown, depth: number) => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 50)) walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (
        keys.has(k.toLowerCase()) &&
        (typeof v === 'string' || typeof v === 'number')
      ) {
        const s = String(v).trim();
        if (/^[A-Za-z0-9-]{4,40}$/.test(s)) found.add(s);
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return [...found].slice(0, 20);
}
