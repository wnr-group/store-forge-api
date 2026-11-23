import type { OrderStatus } from '../../database/schema/enums.js';

/**
 * The order lifecycle as an explicit state machine. Every status change (dashboard, payment webhook, carrier update,
 * expiry job) goes through `assertTransition`, so an order can never jump to an arbitrary status.
 *
 *   pending_payment -> confirmed | cancelled | failed
 *   confirmed       -> processing | cancelled
 *   processing      -> ready_to_ship | cancelled
 *   ready_to_ship   -> shipped | cancelled
 *   shipped         -> out_for_delivery | delivered | returned
 *   out_for_delivery-> delivered | returned
 *   delivered       -> returned
 *   cancelled, failed, returned are final.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_payment: ['confirmed', 'cancelled', 'failed'],
  confirmed: ['processing', 'cancelled'],
  processing: ['ready_to_ship', 'cancelled'],
  ready_to_ship: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'returned'],
  out_for_delivery: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  failed: [],
  returned: [],
};

export const FINAL_STATUSES: readonly OrderStatus[] = [
  'cancelled',
  'failed',
  'returned',
];

/** Statuses a customer may cancel from (before the order is handed to a carrier). */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = [
  'pending_payment',
  'confirmed',
];

export type StatusActor =
  'customer' | 'owner' | 'member' | 'system' | 'payment' | 'carrier';

/** Who may cause which target status. Payment and carrier events are the only sources of their own outcomes. */
const ACTOR_TARGETS: Readonly<Record<StatusActor, readonly OrderStatus[]>> = {
  customer: ['cancelled'],
  owner: [
    'processing',
    'ready_to_ship',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled',
    'returned',
  ],
  member: [
    'processing',
    'ready_to_ship',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled',
    'returned',
  ],
  system: ['cancelled', 'failed'],
  payment: ['confirmed', 'failed', 'cancelled'],
  carrier: ['shipped', 'out_for_delivery', 'delivered', 'returned'],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    reason: 'transition' | 'actor' = 'transition',
  ) {
    super(
      reason === 'actor'
        ? `This actor cannot move an order to ${to}.`
        : `An order cannot move from ${from} to ${to}.`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export const nextStatuses = (from: OrderStatus): readonly OrderStatus[] =>
  TRANSITIONS[from];

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Throws `InvalidTransitionError` unless `actor` may move the order from `from` to `to`. */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: StatusActor,
): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (!ACTOR_TARGETS[actor].includes(to))
    throw new InvalidTransitionError(from, to, 'actor');
  if (actor === 'customer' && !CUSTOMER_CANCELLABLE.includes(from))
    throw new InvalidTransitionError(from, to);
}
