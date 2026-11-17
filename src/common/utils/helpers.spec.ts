import {
  lastDays,
  safeTimeZone,
} from '../../modules/analytics/analytics.service.js';
import { waitText } from '../guards/platform-admin.guard.js';
import { resolveSeriesRange } from '../../modules/platform-admin/usage/series.js';
import { likeTerm, offsetOf } from '../dto/pagination-query.dto.js';
import { Paginated, toMeta } from '../dto/api-response.dto.js';
import { currencyDigits, minorToInput, parseMoney } from './money.js';
import { slugify } from './slug.js';

describe('money', () => {
  it("uses the currency's own number of decimals", () => {
    expect(currencyDigits('INR')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
  });

  it('converts typed amounts to integer minor units without floating point drift', () => {
    expect(parseMoney('1,299.50', 'INR')).toBe(129950);
    expect(parseMoney('0.1', 'USD')).toBe(10);
    expect(parseMoney('19.99', 'USD')).toBe(1999);
    expect(parseMoney('1000', 'JPY')).toBe(1000);
    expect(parseMoney('1.234', 'KWD')).toBe(1234);
  });

  it('refuses amounts the currency cannot represent', () => {
    expect(parseMoney('10.999', 'USD')).toBeNull();
    expect(parseMoney('10.5', 'JPY')).toBeNull();
    expect(parseMoney('-1', 'USD')).toBeNull();
    expect(parseMoney('abc', 'USD')).toBeNull();
    expect(parseMoney('9'.repeat(30), 'USD')).toBeNull(); // not a safe integer
  });

  it('round-trips minor units to editable text', () => {
    expect(minorToInput(129950, 'INR')).toBe('1299.50');
    expect(minorToInput(1000, 'JPY')).toBe('1000');
    expect(parseMoney(minorToInput(1999, 'USD'), 'USD')).toBe(1999);
  });
});

describe('slugify', () => {
  it('makes URL-safe handles', () => {
    expect(slugify('Classic Tee!')).toBe('classic-tee');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('  --a--b--  ')).toBe('a-b');
    expect(slugify('日本語')).toBe('');
    expect(slugify('x'.repeat(100))).toHaveLength(40);
  });
});

describe('pagination helpers', () => {
  it('computes offsets and total pages', () => {
    expect(offsetOf({ page: 3, limit: 20 })).toBe(40);
    expect(toMeta({ page: 1, limit: 10, total: 95 })).toEqual({
      page: 1,
      limit: 10,
      total: 95,
      totalPages: 10,
    });
    expect(toMeta({ page: 1, limit: 10, total: 0 }).totalPages).toBe(1);
    expect(new Paginated([1], { page: 1, limit: 1, total: 1 }).items).toEqual([
      1,
    ]);
  });

  it('escapes LIKE wildcards so user text is matched literally', () => {
    expect(likeTerm('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('analytics helpers', () => {
  it('lists the last N days oldest first in the store timezone', () => {
    const now = Date.UTC(2026, 10, 10, 23, 30); // 23:30 UTC on 10 Nov
    expect(lastDays(3, 'UTC', now)).toEqual([
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
    // Asia/Kolkata is UTC+5:30, so it is already 11 Nov there.
    expect(lastDays(2, 'Asia/Kolkata', now)).toEqual([
      '2026-11-10',
      '2026-11-11',
    ]);
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });
});

describe('usage series range', () => {
  const now = new Date('2026-11-10T12:00:00Z');

  it('defaults to the last 90 days', () => {
    expect(resolveSeriesRange('', '', now)).toEqual({
      from: '2026-08-13',
      to: '2026-11-10',
      bucket: 'week',
    });
  });

  it('swaps backwards dates and caps the range at about three years', () => {
    expect(resolveSeriesRange('2026-11-10', '2026-11-01', now)).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-10',
      bucket: 'day',
    });
    const capped = resolveSeriesRange('2000-01-01', '2026-11-10', now);
    expect(capped.from).toBe('2023-11-11');
    expect(capped.bucket).toBe('month');
  });
});

describe('rate limit wording', () => {
  it('speaks in seconds, then minutes', () => {
    expect(waitText(0)).toBe('1 second');
    expect(waitText(45)).toBe('45 seconds');
    expect(waitText(89)).toBe('89 seconds');
    expect(waitText(500)).toBe('9 minutes');
  });
});
