import { describe, expect, it } from 'vitest';
import {
  assertLockOrder,
  createLockContext,
  DEFAULT_LOCK_TIMEOUT_MS,
} from './lock-order.js';

describe('lock-order support (D50, D51)', () => {
  it('default lock timeout is positive bounded integer', () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(3000);
  });

  it('validates lock context order: store lock before template lock', () => {
    const ctx = createLockContext();
    expect(ctx.hasStoreLock).toBe(false);
    expect(ctx.lockedTemplateIds.size).toBe(0);

    // No template locks: assertLockOrder passes
    expect(() => assertLockOrder(ctx, 'create')).not.toThrow();

    // Template locked without store lock: throws lock order violation
    ctx.lockedTemplateIds.add('uuid-1');
    expect(() => assertLockOrder(ctx, 'create')).toThrow(
      'Lock order violation: cannot perform create without prior store lock',
    );

    // Store locked first: passes
    ctx.hasStoreLock = true;
    expect(() => assertLockOrder(ctx, 'create')).not.toThrow();
  });
});
