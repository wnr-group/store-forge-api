import { describe, expect, it } from 'vitest';
import {
  computeTax,
  divRound,
  formatRate,
  gstinCheckChar,
  isGstRate,
  isHsnCode,
  isValidGstin,
  type TaxableLine,
} from './gst.js';

const line = (
  amountMinor: number,
  rateBps: number,
  over: Partial<TaxableLine> = {},
): TaxableLine => ({
  key: 'a',
  kind: 'item',
  description: 'Thing',
  hsnCode: null,
  amountMinor,
  rateBps,
  ...over,
});

describe('GSTIN', () => {
  it('accepts a well-formed GSTIN with the right check character', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('29AABCT1332L1ZD')).toBe(
      gstinCheckChar('29AABCT1332L1Z') === 'D',
    );
  });

  it('builds valid ones from any first 14 characters', () => {
    for (const first of [
      '07AAACN1234A1Z',
      '33ABCDE1234F1Z',
      '09AAAAA0000A1Z',
      '36ZZZZZ9999Z9Z',
    ]) {
      expect(isValidGstin(first + gstinCheckChar(first))).toBe(true);
    }
  });

  it('rejects a wrong check character, a wrong shape and lower case', () => {
    expect(isValidGstin('27AAPFU0939F1ZA')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1XV')).toBe(false); // 14th character must be Z
    expect(isValidGstin('2AAAPFU09390F1ZV')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });
});

describe('rates and codes', () => {
  it('knows the GST rates', () => {
    for (const r of [0, 25, 300, 500, 1200, 1800, 2800, 4000])
      expect(isGstRate(r)).toBe(true);
    for (const r of [1, 750, 1500, 2000, -100, 10000])
      expect(isGstRate(r)).toBe(false);
  });
  it('shows rates as people write them', () => {
    expect(formatRate(1800)).toBe('18%');
    expect(formatRate(500)).toBe('5%');
    expect(formatRate(25)).toBe('0.25%');
    expect(formatRate(0)).toBe('0%');
  });
  it('accepts 4, 6 or 8 digit HSN/SAC codes only', () => {
    for (const h of ['6109', '610910', '61091000'])
      expect(isHsnCode(h)).toBe(true);
    for (const h of [
      '610',
      '61091',
      '6109100',
      '610910000',
      '61A9',
      '',
      '6109 ',
    ])
      expect(isHsnCode(h)).toBe(false);
  });
  it('rounds half up', () => {
    expect(divRound(5, 10)).toBe(1);
    expect(divRound(4, 10)).toBe(0);
    expect(divRound(15, 10)).toBe(2);
    expect(divRound(0, 7)).toBe(0);
  });
});

describe('tax in the same state: CGST + SGST', () => {
  it('adds 18% on top of a price, half to each', () => {
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '29',
      inclusive: false,
      lines: [line(100000, 1800)],
    });
    expect(r).toMatchObject({
      regime: 'intra',
      stateTaxKind: 'sgst',
      cgstMinor: 9000,
      sgstMinor: 9000,
      igstMinor: 0,
      taxMinor: 18000,
    });
    expect(r.lines[0]).toMatchObject({ taxableMinor: 100000, rateBps: 1800 });
  });

  it('takes tax out of a price that already has it', () => {
    // 1180.00 incl. 18%: taxable 1000.00, tax 180.00
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '29',
      inclusive: true,
      lines: [line(118000, 1800)],
    });
    expect(r.lines[0]).toMatchObject({
      taxableMinor: 100000,
      cgstMinor: 9000,
      sgstMinor: 9000,
      taxMinor: 18000,
    });
    expect(r.lines[0].taxableMinor + r.lines[0].taxMinor).toBe(118000);
  });

  it('always keeps the two halves equal and the line adding up, at awkward amounts', () => {
    for (const inclusive of [false, true])
      for (const rate of [25, 300, 500, 1200, 1800, 2800, 4000])
        for (const amount of [1, 7, 99, 101, 12345, 99999, 123457, 9999999]) {
          const r = computeTax({
            supplierStateCode: '27',
            supplyStateCode: '27',
            inclusive,
            lines: [line(amount, rate)],
          });
          const l = r.lines[0];
          expect(l.cgstMinor).toBe(l.sgstMinor);
          expect(l.taxMinor).toBe(l.cgstMinor + l.sgstMinor + l.igstMinor);
          expect(l.taxableMinor).toBeGreaterThanOrEqual(0);
          if (inclusive) expect(l.taxableMinor + l.taxMinor).toBe(amount);
        }
  });

  it('charges UTGST instead of SGST in a union territory without a legislature', () => {
    for (const code of ['04', '26', '31', '35', '38'])
      expect(
        computeTax({
          supplierStateCode: code,
          supplyStateCode: code,
          inclusive: false,
          lines: [line(10000, 500)],
        }).stateTaxKind,
      ).toBe('utgst');
    for (const code of ['07', '34', '27'])
      expect(
        computeTax({
          supplierStateCode: code,
          supplyStateCode: code,
          inclusive: false,
          lines: [line(10000, 500)],
        }).stateTaxKind,
      ).toBe('sgst');
  });
});

describe('tax between states: IGST', () => {
  it('charges the full rate as IGST', () => {
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '27',
      inclusive: false,
      lines: [line(100000, 1800)],
    });
    expect(r).toMatchObject({
      regime: 'inter',
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 18000,
      taxMinor: 18000,
    });
  });

  it('takes IGST out of an inclusive price', () => {
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '27',
      inclusive: true,
      lines: [line(11800, 1800)],
    });
    expect(r.lines[0]).toMatchObject({ taxableMinor: 10000, igstMinor: 1800 });
  });
});

describe('several lines', () => {
  it('taxes each line at its own rate and totals them', () => {
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '27',
      inclusive: false,
      lines: [
        line(100000, 500, { key: 'a' }),
        line(50000, 1800, { key: 'b' }),
        line(4000, 1800, {
          key: 'ship',
          kind: 'shipping',
          description: 'Shipping',
        }),
        line(20000, 0, { key: 'c' }),
      ],
    });
    expect(r.lines.map((l) => [l.key, l.igstMinor])).toEqual([
      ['a', 5000],
      ['b', 9000],
      ['ship', 720],
      ['c', 0],
    ]);
    expect(r.igstMinor).toBe(14720);
    expect(r.taxMinor).toBe(14720);
  });

  it('skips lines with nothing to pay (free shipping, no cash-on-delivery charge)', () => {
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '29',
      inclusive: false,
      lines: [
        line(1000, 1800),
        line(0, 1800, { key: 'ship', kind: 'shipping' }),
      ],
    });
    expect(r.lines).toHaveLength(1);
  });

  it('is exactly the sum of its lines, never a separately rounded total', () => {
    // Three lines of 0.33 at 18%: each rounds on its own; the order's tax is their sum.
    const lines = [
      line(33, 1800, { key: '1' }),
      line(33, 1800, { key: '2' }),
      line(33, 1800, { key: '3' }),
    ];
    const r = computeTax({
      supplierStateCode: '29',
      supplyStateCode: '29',
      inclusive: false,
      lines,
    });
    expect(r.taxMinor).toBe(r.lines.reduce((n, l) => n + l.taxMinor, 0));
    expect(r.cgstMinor).toBe(r.sgstMinor);
  });

  it('gives nothing for an empty order', () => {
    expect(
      computeTax({
        supplierStateCode: '29',
        supplyStateCode: '29',
        inclusive: false,
        lines: [],
      }),
    ).toMatchObject({ taxMinor: 0, lines: [] });
  });
});
