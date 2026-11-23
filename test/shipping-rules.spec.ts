import { describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import {
  chooseCarrier,
  type CarrierCandidate,
} from '../src/modules/shipping/carrier-selection.js';
import {
  expandAreas,
  findConflicts,
  normalizeCity,
  type AreaRow,
} from '../src/modules/shipping/shipping-areas.js';
import {
  chargeFor,
  eligibility,
  tierFor,
  tierProblems,
  type PricedMethod,
} from '../src/modules/shipping/shipping-pricing.js';
import { stateNameOf } from '../src/modules/shipping/shipping-quote.service.js';

const errorsOf = (work: () => unknown): Record<string, string> => {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException)
      return (error.details ?? {}) as Record<string, string>;
    throw error;
  }
  throw new Error('expected a validation error');
};

describe('zone areas', () => {
  it('expands every kind of area, resolving state names and codes and normalising cities', () => {
    const rows = expandAreas({
      country: false,
      states: ['Karnataka', '27'],
      cities: [{ state: 'tamil nadu', city: '  Coimbatore ' }],
      postalCodes: ['560001', '560002'],
      postalRanges: [{ from: '400001', to: '400099' }],
    });
    expect(rows.map((r) => r.kind).sort()).toEqual([
      'city',
      'postal_code',
      'postal_code',
      'postal_range',
      'state',
      'state',
    ]);
    expect(rows.find((r) => r.kind === 'city')).toMatchObject({
      stateCode: '33',
      city: 'coimbatore',
    });
    expect(
      rows
        .filter((r) => r.kind === 'state')
        .map((r) => r.stateCode)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['27', '29']);
  });

  it('merges duplicates inside one zone', () => {
    const rows = expandAreas({
      states: ['Goa', 'goa', '30'],
      postalCodes: ['560001', ' 560001 '],
    });
    expect(rows).toHaveLength(2);
  });

  it('reports every problem at once, per entry, and needs at least one area', () => {
    const errors = errorsOf(() =>
      expandAreas({
        states: ['Atlantis'],
        cities: [
          { state: 'Goa', city: '' },
          { state: 'Nowhere', city: 'X' },
        ],
        postalCodes: ['12345', 'abcdef', '056001'],
        postalRanges: [
          { from: '500010', to: '500001' },
          { from: '12', to: '999999' },
        ],
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        'cities.0.city',
        'cities.1.state',
        'postalCodes.0',
        'postalCodes.1',
        'postalCodes.2',
        'postalRanges.0',
        'postalRanges.1',
        'states.0',
      ].sort(),
    );
    expect(errorsOf(() => expandAreas({}))).toEqual({
      areas: 'Add at least one area to this zone.',
    });
  });

  it('refuses two overlapping PIN ranges in the same zone', () => {
    const errors = errorsOf(() =>
      expandAreas({
        postalRanges: [
          { from: '400001', to: '400100' },
          { from: '400050', to: '400200' },
        ],
      }),
    );
    expect(Object.values(errors)[0]).toMatch(/overlaps/);
    // Touching is overlapping, because both ends are inclusive.
    expect(() =>
      expandAreas({
        postalRanges: [
          { from: '400001', to: '400100' },
          { from: '400101', to: '400200' },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a zone with more areas than allowed', () => {
    const many = Array.from({ length: 5001 }, (_, i) => String(100000 + i));
    expect(errorsOf(() => expandAreas({ postalCodes: many }))).toHaveProperty(
      'areas',
    );
  });

  describe('conflicts between zones', () => {
    const row = (over: Partial<AreaRow>): AreaRow => ({
      kind: 'state',
      stateCode: null,
      city: null,
      postalCode: null,
      postalFrom: null,
      postalTo: null,
      ...over,
    });
    const others = [
      {
        zoneName: 'South',
        areas: [
          row({ kind: 'state', stateCode: '29' }),
          row({ kind: 'city', stateCode: '33', city: 'chennai' }),
          row({ kind: 'postal_code', postalCode: '682001' }),
          row({
            kind: 'postal_range',
            postalFrom: '600001',
            postalTo: '600100',
          }),
          row({ kind: 'country' }),
        ],
      },
    ];

    it('finds the same area in another zone, and names that zone', () => {
      const found = findConflicts(
        [
          row({ kind: 'state', stateCode: '29' }),
          row({ kind: 'city', stateCode: '33', city: 'chennai' }),
          row({ kind: 'postal_code', postalCode: '682001' }),
          row({ kind: 'country' }),
        ],
        others,
        stateNameOf,
      );
      expect(found).toHaveLength(4);
      expect(found.every((m) => m.includes('"South"'))).toBe(true);
      expect(found[0]).toContain('Karnataka');
    });

    it('finds overlapping PIN ranges, including a range inside another', () => {
      expect(
        findConflicts(
          [
            row({
              kind: 'postal_range',
              postalFrom: '600050',
              postalTo: '600500',
            }),
          ],
          others,
          stateNameOf,
        ),
      ).toHaveLength(1);
      expect(
        findConflicts(
          [
            row({
              kind: 'postal_range',
              postalFrom: '600010',
              postalTo: '600020',
            }),
          ],
          others,
          stateNameOf,
        ),
      ).toHaveLength(1);
      expect(
        findConflicts(
          [
            row({
              kind: 'postal_range',
              postalFrom: '600101',
              postalTo: '600200',
            }),
          ],
          others,
          stateNameOf,
        ),
      ).toEqual([]);
    });

    it('allows what is more specific than another zone: a PIN inside a range, a city inside a state', () => {
      const mine = [
        row({ kind: 'postal_code', postalCode: '600050' }),
        row({ kind: 'city', stateCode: '29', city: 'mysuru' }),
        row({ kind: 'state', stateCode: '27' }),
      ];
      expect(findConflicts(mine, others, stateNameOf)).toEqual([]);
    });
  });

  it('normalises city names so spelling variants meet', () => {
    expect(normalizeCity('  New   DELHI ')).toBe('new delhi');
  });
});

const method = (over: Partial<PricedMethod> = {}): PricedMethod => ({
  id: 'm1',
  name: 'Standard',
  kind: 'standard',
  pricingType: 'flat',
  flatRateMinor: 5000,
  freeOverMinor: null,
  handlingMinor: 0,
  minOrderMinor: 0,
  maxOrderMinor: null,
  minWeightGrams: 0,
  maxWeightGrams: null,
  estDaysMin: 3,
  estDaysMax: 5,
  codAllowed: true,
  carrierCode: null,
  tiers: [],
  ...over,
});
const cart = (subtotalMinor = 100000, weightGrams = 500) => ({
  subtotalMinor,
  weightGrams,
});

describe('shipping charges', () => {
  it('flat and free', () => {
    expect(chargeFor(method(), cart())).toEqual({
      ok: true,
      chargeMinor: 5000,
      free: false,
    });
    expect(chargeFor(method({ flatRateMinor: 0 }), cart())).toEqual({
      ok: true,
      chargeMinor: 0,
      free: true,
    });
    expect(
      chargeFor(method({ pricingType: 'free', flatRateMinor: 999 }), cart()),
    ).toEqual({ ok: true, chargeMinor: 0, free: true });
  });

  it('becomes free once the threshold is reached, for every pricing type', () => {
    const m = method({ freeOverMinor: 100000 });
    expect(chargeFor(m, cart(99999))).toMatchObject({
      chargeMinor: 5000,
      free: false,
    });
    expect(chargeFor(m, cart(100000))).toMatchObject({
      chargeMinor: 0,
      free: true,
    });
    expect(
      chargeFor(
        method({
          pricingType: 'carrier',
          handlingMinor: 3000,
          freeOverMinor: 50000,
        }),
        cart(60000),
      ),
    ).toMatchObject({ chargeMinor: 0, free: true });
  });

  it('weight tiers: the band the weight falls in, upper bound exclusive', () => {
    const m = method({
      pricingType: 'weight',
      tiers: [
        { from: 0, to: 500, rateMinor: 4000 },
        { from: 500, to: 2000, rateMinor: 7000 },
        { from: 2000, to: null, rateMinor: 12000 },
      ],
    });
    expect(chargeFor(m, cart(1, 499))).toMatchObject({ chargeMinor: 4000 });
    expect(chargeFor(m, cart(1, 500))).toMatchObject({ chargeMinor: 7000 });
    expect(chargeFor(m, cart(1, 2000))).toMatchObject({ chargeMinor: 12000 });
    expect(chargeFor(m, cart(1, 90000))).toMatchObject({ chargeMinor: 12000 });
  });

  it('order-value tiers use the subtotal, and a rate of zero counts as free', () => {
    const m = method({
      pricingType: 'order_value',
      tiers: [
        { from: 0, to: 50000, rateMinor: 6000 },
        { from: 50000, to: null, rateMinor: 0 },
      ],
    });
    expect(chargeFor(m, cart(49999))).toMatchObject({
      chargeMinor: 6000,
      free: false,
    });
    expect(chargeFor(m, cart(50000))).toMatchObject({
      chargeMinor: 0,
      free: true,
    });
  });

  it('carrier pricing adds the handling fee, and is not offered without a live price', () => {
    const m = method({ pricingType: 'carrier', handlingMinor: 2500 });
    expect(chargeFor(m, cart(), 8000)).toEqual({
      ok: true,
      chargeMinor: 10500,
      free: false,
    });
    expect(chargeFor(m, cart(), null)).toMatchObject({ ok: false });
  });

  it('a band that does not cover the value is "no rate", never a guess', () => {
    const m = method({
      pricingType: 'weight',
      tiers: [{ from: 100, to: 200, rateMinor: 1 }],
    });
    expect(chargeFor(m, cart(1, 50))).toMatchObject({ ok: false });
  });
});

describe('shipping eligibility', () => {
  it('applies order value limits, both inclusive', () => {
    const m = method({ minOrderMinor: 10000, maxOrderMinor: 50000 });
    expect(eligibility(m, cart(9999)).ok).toBe(false);
    expect(eligibility(m, cart(10000)).ok).toBe(true);
    expect(eligibility(m, cart(50000)).ok).toBe(true);
    expect(eligibility(m, cart(50001)).ok).toBe(false);
  });

  it('applies weight limits, and treats unknown weight as ineligible when weight matters', () => {
    const m = method({ minWeightGrams: 100, maxWeightGrams: 2000 });
    expect(eligibility(m, cart(1, 99)).ok).toBe(false);
    expect(eligibility(m, cart(1, 2000)).ok).toBe(true);
    expect(eligibility(m, cart(1, 2001)).ok).toBe(false);
    expect(eligibility(m, cart(1, 0))).toEqual({
      ok: false,
      reason: 'The weight of the items is not known.',
    });
  });

  it('never prices by weight or by carrier when the weight is unknown, but a flat rate does not care', () => {
    expect(
      eligibility(
        method({
          pricingType: 'weight',
          tiers: [{ from: 0, to: null, rateMinor: 1 }],
        }),
        cart(1, 0),
      ).ok,
    ).toBe(false);
    expect(eligibility(method({ pricingType: 'carrier' }), cart(1, 0)).ok).toBe(
      false,
    );
    expect(eligibility(method({ pricingType: 'flat' }), cart(1, 0)).ok).toBe(
      true,
    );
    expect(
      eligibility(method({ pricingType: 'order_value', tiers: [] }), cart(1, 0))
        .ok,
    ).toBe(true);
  });
});

describe('rate bands', () => {
  it('accepts bands that start at 0, join up and end open', () => {
    expect(
      tierProblems([
        { from: 0, to: 500, rateMinor: 1 },
        { from: 500, to: null, rateMinor: 2 },
      ]),
    ).toEqual([]);
    expect(
      tierProblems([
        { from: 500, to: null, rateMinor: 2 },
        { from: 0, to: 500, rateMinor: 1 },
      ]),
    ).toEqual([]);
    expect(
      tierFor([{ from: 0, to: null, rateMinor: 9 }], 123456)?.rateMinor,
    ).toBe(9);
  });

  it('names every kind of mistake', () => {
    expect(tierProblems([])).toEqual(['Add at least one rate band.']);
    expect(tierProblems([{ from: 10, to: null, rateMinor: 1 }])).toContain(
      'The first rate band must start at 0.',
    );
    expect(
      tierProblems([
        { from: 0, to: 100, rateMinor: 1 },
        { from: 200, to: null, rateMinor: 1 },
      ]).join(),
    ).toMatch(/gap/);
    expect(
      tierProblems([
        { from: 0, to: 300, rateMinor: 1 },
        { from: 200, to: null, rateMinor: 1 },
      ]).join(),
    ).toMatch(/overlap/);
    expect(tierProblems([{ from: 0, to: 100, rateMinor: 1 }])).toContain(
      'The last band must have no upper limit.',
    );
    expect(
      tierProblems([
        { from: 0, to: null, rateMinor: 1 },
        { from: 100, to: null, rateMinor: 1 },
      ]),
    ).toContain('Only the last band can have no upper limit.');
    expect(tierProblems([{ from: 0, to: null, rateMinor: -5 }])).toContain(
      'A rate cannot be negative.',
    );
  });
});

describe('choosing a carrier', () => {
  const c = (
    providerCode: string,
    serviceCode: string,
    amountMinor: number,
    days: number | null,
  ): CarrierCandidate => ({
    providerCode,
    providerName: providerCode,
    serviceCode,
    serviceName: serviceCode,
    amountMinor,
    currency: 'INR',
    estimatedDeliveryDays: days,
    codChargeMinor: null,
    estimate: false,
  });
  const set = [
    c('shiprocket', '10', 9000, 4),
    c('shiprocket', '11', 15000, 2),
    c('delhivery', 'S', 7000, null),
    c('delhivery', 'E', 13000, null),
  ];

  it('lowest cost picks the cheapest, and breaks a tie by speed', () => {
    expect(
      chooseCarrier(set, 'lowest_cost', 'automatic', null).candidate,
    ).toMatchObject({ providerCode: 'delhivery', serviceCode: 'S' });
    const tie = [c('a', '1', 5000, 6), c('b', '1', 5000, 3)];
    expect(
      chooseCarrier(tie, 'lowest_cost', 'automatic', null).candidate
        ?.providerCode,
    ).toBe('b');
  });

  it('fastest picks the shortest time among carriers that give one, and says when it had to fall back', () => {
    const fastest = chooseCarrier(set, 'fastest', 'automatic', null);
    expect(fastest.candidate).toMatchObject({
      providerCode: 'shiprocket',
      serviceCode: '11',
    });
    expect(fastest.fellBack).toBe(false);
    const noTimes = chooseCarrier(
      [c('delhivery', 'S', 7000, null), c('delhivery', 'E', 13000, null)],
      'fastest',
      'automatic',
      null,
    );
    expect(noTimes).toMatchObject({
      fellBack: true,
      candidate: { serviceCode: 'S' },
    });
    expect(noTimes.reason).toMatch(/lowest price/);
  });

  it('preferred uses the default carrier’s cheapest service, and falls back honestly', () => {
    expect(
      chooseCarrier(set, 'preferred', 'automatic', 'shiprocket').candidate,
    ).toMatchObject({ providerCode: 'shiprocket', serviceCode: '10' });
    const off = chooseCarrier(set, 'preferred', 'automatic', 'bluedart');
    expect(off).toMatchObject({
      fellBack: true,
      candidate: { providerCode: 'delhivery' },
    });
    expect(off.reason).toMatch(/cannot deliver/);
    expect(chooseCarrier(set, 'preferred', 'automatic', null)).toMatchObject({
      fellBack: true,
    });
  });

  it('chooses nothing in manual mode, and nothing when no carrier can deliver', () => {
    expect(chooseCarrier(set, 'lowest_cost', 'manual', null)).toMatchObject({
      candidate: null,
    });
    expect(chooseCarrier([], 'lowest_cost', 'automatic', null)).toMatchObject({
      candidate: null,
      reason: 'No connected carrier can deliver this parcel.',
    });
  });

  it('is deterministic and does not reorder what it was given', () => {
    const copy = [...set];
    chooseCarrier(set, 'lowest_cost', 'automatic', null);
    expect(set).toEqual(copy);
    expect(
      chooseCarrier([...set].reverse(), 'lowest_cost', 'automatic', null)
        .candidate,
    ).toEqual(chooseCarrier(set, 'lowest_cost', 'automatic', null).candidate);
  });
});
