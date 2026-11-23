import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../../database/schema/enums.js';
import {
  assertTransition,
  canTransition,
  FINAL_STATUSES,
  InvalidTransitionError,
  nextStatuses,
} from './order-state.js';

describe('order state machine', () => {
  it('allows the happy path one step at a time', () => {
    const path = [
      'pending_payment',
      'confirmed',
      'processing',
      'ready_to_ship',
      'shipped',
      'out_for_delivery',
      'delivered',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1)
      expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('never skips ahead or goes backwards', () => {
    expect(canTransition('pending_payment', 'shipped')).toBe(false);
    expect(canTransition('confirmed', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'processing')).toBe(false);
    expect(canTransition('shipped', 'confirmed')).toBe(false);
  });

  it('treats cancelled, failed and returned as final', () => {
    for (const status of FINAL_STATUSES) {
      expect(nextStatuses(status)).toEqual([]);
      for (const to of ORDER_STATUSES)
        expect(canTransition(status, to)).toBe(false);
    }
  });

  it('only allows cancelling before the order is shipped', () => {
    expect(canTransition('ready_to_ship', 'cancelled')).toBe(true);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
  });

  it('lets only the payment side confirm or fail an unpaid order', () => {
    expect(() =>
      assertTransition('pending_payment', 'confirmed', 'payment'),
    ).not.toThrow();
    expect(() =>
      assertTransition('pending_payment', 'confirmed', 'owner'),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      assertTransition('pending_payment', 'failed', 'member'),
    ).toThrow(InvalidTransitionError);
  });

  it('lets only carriers (or staff) report shipping progress', () => {
    expect(() =>
      assertTransition('shipped', 'delivered', 'carrier'),
    ).not.toThrow();
    expect(() =>
      assertTransition('shipped', 'delivered', 'customer'),
    ).toThrow();
    expect(() => assertTransition('confirmed', 'shipped', 'carrier')).toThrow();
  });

  it('lets a customer cancel only before processing starts', () => {
    expect(() =>
      assertTransition('pending_payment', 'cancelled', 'customer'),
    ).not.toThrow();
    expect(() =>
      assertTransition('confirmed', 'cancelled', 'customer'),
    ).not.toThrow();
    expect(() =>
      assertTransition('processing', 'cancelled', 'customer'),
    ).toThrow(InvalidTransitionError);
  });
});
