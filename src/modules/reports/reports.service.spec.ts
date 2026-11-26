import { describe, expect, it } from 'vitest';
import {
  compare,
  figuresOf,
  previousRange,
  sumRows,
} from './reports.service.js';

const row = (over: Partial<Parameters<typeof figuresOf>[0]> = {}) => ({
  orders: 0,
  gross: 0,
  discounts: 0,
  refunds: 0,
  fees: 0,
  tax: 0,
  total: 0,
  ...over,
});

describe('how the sales figures relate', () => {
  it('net sales is gross sales less discounts less refunds, and net revenue is what was charged less refunds', () => {
    const f = figuresOf(
      row({
        orders: 4,
        gross: 430000,
        discounts: 25000,
        refunds: 30000,
        fees: 8000,
        total: 413000,
      }),
    );
    expect(f.netSalesMinor).toBe(375000);
    expect(f.netRevenueMinor).toBe(383000);
    expect(f.averageOrderValueMinor).toBe(103250);
    // The charge is the items, less discounts, plus delivery and fees (no tax in this example).
    expect(f.totalSalesMinor).toBe(
      f.grossSalesMinor - f.discountsMinor + f.shippingAndFeesMinor,
    );
  });

  it('has an average order of zero, not NaN, without orders', () => {
    expect(figuresOf(row()).averageOrderValueMinor).toBe(0);
  });

  it('sums periods without losing or doubling anything, so totals equal the series', () => {
    const rows = [
      row({ orders: 2, gross: 300000, discounts: 20000, total: 288000 }),
      row(),
      row({ orders: 1, gross: 80000, refunds: 30000, total: 80000 }),
    ];
    const total = figuresOf(sumRows(rows));
    expect(total.orders).toBe(3);
    expect(total.grossSalesMinor).toBe(380000);
    expect(total.refundsMinor).toBe(30000);
    expect(total.netSalesMinor).toBe(
      rows.reduce((n, r) => n + figuresOf(r).netSalesMinor, 0),
    );
  });

  it('reads database numbers that arrive as strings', () => {
    const f = figuresOf(
      row({
        orders: '2' as never,
        gross: '1000' as never,
        total: '900' as never,
      }),
    );
    expect(f.grossSalesMinor).toBe(1000);
    expect(f.averageOrderValueMinor).toBe(450);
  });
});

describe('the comparison period', () => {
  it('is the same number of days, ending the day before', () => {
    expect(
      previousRange({ from: '2026-03-01', to: '2026-03-31', days: 31 }),
    ).toEqual({
      from: '2026-01-29',
      to: '2026-02-28',
      days: 31,
    });
    expect(
      previousRange({ from: '2026-03-05', to: '2026-03-05', days: 1 }),
    ).toEqual({
      from: '2026-03-04',
      to: '2026-03-04',
      days: 1,
    });
  });

  it('reports change in percent, and null instead of dividing by zero', () => {
    const now = figuresOf(row({ orders: 4, gross: 400, total: 400 }));
    const before = figuresOf(row({ orders: 1, gross: 100, total: 100 }));
    expect(compare(now, before)).toMatchObject({
      orders: 300,
      grossSalesMinor: 300,
      totalSalesMinor: 300,
    });
    expect(compare(now, figuresOf(row())).orders).toBeNull();
    expect(
      compare(
        figuresOf(row({ orders: 1, total: 90 })),
        figuresOf(row({ orders: 1, total: 100 })),
      ).totalSalesMinor,
    ).toBe(-10);
  });
});
