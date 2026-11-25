import { describe, expect, it } from 'vitest';
import { AppException } from '../app.exception.js';
import { resolveDayRange, todayIn } from './date-range-query.dto.js';

const fail = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppException) return e;
    throw e;
  }
  throw new Error('expected a failure');
};

describe('day ranges', () => {
  it('counts today in the store time zone, not UTC', () => {
    const lateUtc = Date.parse('2026-11-24T20:00:00Z'); // already 25 Nov, 01:30 in India
    expect(todayIn('UTC', lateUtc)).toBe('2026-11-24');
    expect(todayIn('Asia/Kolkata', lateUtc)).toBe('2026-11-25');
  });

  it('defaults to the last 30 days ending today, both ends included', () => {
    const r = resolveDayRange({}, 'UTC');
    expect(r.days).toBe(30);
    expect(r.to).toBe(todayIn('UTC'));
  });

  it('takes an explicit range and counts its days', () => {
    expect(
      resolveDayRange({ from: '2026-11-01', to: '2026-11-30' }, 'UTC'),
    ).toEqual({ from: '2026-11-01', to: '2026-11-30', days: 30 });
    expect(
      resolveDayRange({ from: '2026-11-05', to: '2026-11-05' }, 'UTC').days,
    ).toBe(1);
  });

  it('starts before the end date when only the end is given', () => {
    expect(
      resolveDayRange({ to: '2026-11-10' }, 'UTC', { defaultDays: 7 }),
    ).toEqual({
      from: '2026-11-04',
      to: '2026-11-10',
      days: 7,
    });
  });

  it('refuses unreal dates, backwards ranges and ranges that are too long', () => {
    expect(
      fail(() => resolveDayRange({ from: '2026-02-30' }, 'UTC')).code,
    ).toBe('DATE_RANGE_INVALID');
    expect(
      fail(() =>
        resolveDayRange({ from: '2026-11-10', to: '2026-11-01' }, 'UTC'),
      ).code,
    ).toBe('DATE_RANGE_INVALID');
    expect(
      fail(() =>
        resolveDayRange({ from: '2024-01-01', to: '2026-01-01' }, 'UTC'),
      ).code,
    ).toBe('DATE_RANGE_TOO_LONG');
    expect(
      resolveDayRange({ from: '2024-01-01', to: '2026-01-01' }, 'UTC', {
        maxDays: 1000,
      }).days,
    ).toBe(732);
  });
});
