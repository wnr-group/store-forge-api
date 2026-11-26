import { invalid } from '../../common/app.exception.js';
import type { ZoneAreaKind } from '../../database/schema/shipping.js';
import { findIndianState } from '../orders/indian-states.js';

/**
 * What a shipping zone covers, and the rules that keep zones unambiguous.
 *
 * An area is one of: the whole country, a state, a city (inside a state), a single PIN code, or a PIN code range. A destination
 * matches the zone holding its MOST SPECIFIC area, in that order of precision: PIN code, PIN range, city, state, country.
 * Ambiguity is impossible when no two zones hold the same area and no two PIN ranges overlap, which is what `findConflicts`
 * enforces (the database refuses the exact duplicates as well). A PIN code inside another zone's range is fine: the single PIN is
 * the more specific, so it wins.
 */
export interface AreasInput {
  country?: boolean;
  /** State names or two-digit GST state codes. */
  states?: string[];
  cities?: { state: string; city: string }[];
  postalCodes?: string[];
  postalRanges?: { from: string; to: string }[];
}

export interface AreaRow {
  kind: ZoneAreaKind;
  stateCode: string | null;
  city: string | null;
  postalCode: string | null;
  postalFrom: string | null;
  postalTo: string | null;
}

export const MAX_AREAS_PER_ZONE = 5000;
const PIN = /^[1-9]\d{5}$/;

/** How precisely an area pins down a destination: higher wins. */
export const SPECIFICITY: Record<ZoneAreaKind, number> = {
  postal_code: 5,
  postal_range: 4,
  city: 3,
  state: 2,
  country: 1,
};

export const normalizeCity = (city: string): string =>
  city.trim().replace(/\s+/g, ' ').toLowerCase();

const empty = (kind: ZoneAreaKind): AreaRow => ({
  kind,
  stateCode: null,
  city: null,
  postalCode: null,
  postalFrom: null,
  postalTo: null,
});

/** Turns what the Owner entered into area rows, or explains everything that is wrong. Duplicates within the input are merged. */
export function expandAreas(input: AreasInput): AreaRow[] {
  const errors: Record<string, string> = {};
  const rows = new Map<string, AreaRow>();
  const add = (row: AreaRow) => rows.set(areaKey(row), row);

  if (input.country === true) add(empty('country'));

  (input.states ?? []).forEach((s, i) => {
    const state = typeof s === 'string' ? findIndianState(s) : undefined;
    if (!state)
      errors[`states.${i}`] = 'Choose a valid Indian state or union territory.';
    else add({ ...empty('state'), stateCode: state.code });
  });

  (input.cities ?? []).forEach((c, i) => {
    const state =
      typeof c?.state === 'string' ? findIndianState(c.state) : undefined;
    const city = typeof c?.city === 'string' ? normalizeCity(c.city) : '';
    if (!state)
      errors[`cities.${i}.state`] =
        'Choose a valid Indian state or union territory.';
    else if (city.length < 1 || city.length > 100)
      errors[`cities.${i}.city`] = 'Enter a city name (up to 100 characters).';
    else add({ ...empty('city'), stateCode: state.code, city });
  });

  (input.postalCodes ?? []).forEach((p, i) => {
    if (typeof p !== 'string' || !PIN.test(p.trim()))
      errors[`postalCodes.${i}`] = 'Enter a valid 6-digit PIN code.';
    else add({ ...empty('postal_code'), postalCode: p.trim() });
  });

  const ranges: { from: string; to: string; index: number }[] = [];
  (input.postalRanges ?? []).forEach((r, i) => {
    const from = typeof r?.from === 'string' ? r.from.trim() : '';
    const to = typeof r?.to === 'string' ? r.to.trim() : '';
    if (!PIN.test(from) || !PIN.test(to))
      errors[`postalRanges.${i}`] =
        'Enter both ends as valid 6-digit PIN codes.';
    else if (from > to)
      errors[`postalRanges.${i}`] =
        'The first PIN code must not be higher than the last.';
    else ranges.push({ from, to, index: i });
  });
  // Two ranges of the same zone may not overlap either.
  ranges.sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < ranges.length; i += 1)
    if (ranges[i].from <= ranges[i - 1].to)
      errors[`postalRanges.${ranges[i].index}`] =
        'This PIN code range overlaps another range of this zone.';
  for (const r of ranges)
    add({ ...empty('postal_range'), postalFrom: r.from, postalTo: r.to });

  if (rows.size > MAX_AREAS_PER_ZONE)
    errors.areas = `A zone can hold at most ${MAX_AREAS_PER_ZONE} areas.`;
  if (Object.keys(errors).length > 0)
    throw invalid(
      'Some zone areas need attention.',
      errors,
      'ZONE_AREAS_INVALID',
    );
  if (rows.size === 0)
    throw invalid(
      'Add at least one area to this zone.',
      { areas: 'Add at least one area to this zone.' },
      'ZONE_AREAS_INVALID',
    );
  return [...rows.values()];
}

/** The identity of an area, so duplicates can be found. */
export function areaKey(a: AreaRow): string {
  switch (a.kind) {
    case 'country':
      return 'country';
    case 'state':
      return `state:${a.stateCode}`;
    case 'city':
      return `city:${a.stateCode}:${a.city}`;
    case 'postal_code':
      return `pin:${a.postalCode}`;
    case 'postal_range':
      return `range:${a.postalFrom}-${a.postalTo}`;
  }
}

export function describeArea(
  a: AreaRow,
  stateName: (code: string) => string,
): string {
  switch (a.kind) {
    case 'country':
      return 'all of India';
    case 'state':
      return stateName(a.stateCode!);
    case 'city':
      return `${a.city} (${stateName(a.stateCode!)})`;
    case 'postal_code':
      return `PIN code ${a.postalCode}`;
    case 'postal_range':
      return `PIN codes ${a.postalFrom} to ${a.postalTo}`;
  }
}

const overlaps = (a: AreaRow, b: AreaRow) =>
  a.postalFrom! <= b.postalTo! && b.postalFrom! <= a.postalTo!;

/**
 * What would make this zone ambiguous next to the tenant's other zones: the same area already in another zone, or a PIN range that
 * overlaps one. Returns plain sentences naming the other zone.
 */
export function findConflicts(
  mine: readonly AreaRow[],
  others: readonly { zoneName: string; areas: readonly AreaRow[] }[],
  stateName: (code: string) => string,
): string[] {
  const messages: string[] = [];
  for (const other of others) {
    const keys = new Set(other.areas.map(areaKey));
    for (const a of mine) {
      if (a.kind === 'postal_range') {
        const clash = other.areas.find(
          (b) => b.kind === 'postal_range' && overlaps(a, b),
        );
        if (clash)
          messages.push(
            `${describeArea(a, stateName)} overlap ${describeArea(clash, stateName)} in the zone "${other.zoneName}".`,
          );
      } else if (keys.has(areaKey(a))) {
        messages.push(
          `${describeArea(a, stateName)} is already in the zone "${other.zoneName}".`,
        );
      }
    }
  }
  return messages;
}
