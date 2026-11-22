/**
 * Display-rule validation, mirroring the frontend's lib/templates/display-rules.ts (schema v2):
 *   node.display = { v: 1, rules: [ { type: "schedule", startsAt?, endsAt?, timezone? }, { type: "device", desktop, tablet, mobile } ] }
 * Instants are ISO 8601 with an explicit offset, the end is after the start, and at most one schedule and one device rule.
 */

export const DISPLAY_RULES_VERSION = 1;
export const MAX_DISPLAY_RULES = 2;
const MAX_TIMEZONE_LENGTH = 64;

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant in epoch milliseconds, or null for anything that is not a real calendar instant in the strict form. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(
    Number,
  );
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isKnownTimezone(tz: unknown): boolean {
  if (
    typeof tz !== 'string' ||
    tz.length < 1 ||
    tz.length > MAX_TIMEZONE_LENGTH
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface DisplayProblem {
  code: 'invalid' | 'order';
  message: string;
}

export interface DisplayAnalysis {
  problems: DisplayProblem[];
  /** The schedule's instants when they are valid (used for the expiry warning). */
  schedule: { startsAt: number | null; endsAt: number | null } | null;
  /** True when a valid device rule hides the node on every device. */
  hiddenEverywhere: boolean;
}

/** Reads `node.display`. A missing value is fine (no rules). Anything malformed is reported, never thrown. */
export function analyzeDisplay(display: unknown): DisplayAnalysis {
  const out: DisplayAnalysis = {
    problems: [],
    schedule: null,
    hiddenEverywhere: false,
  };
  if (display === undefined) return out;
  const bad = (message: string) =>
    out.problems.push({ code: 'invalid', message });
  if (!isRecord(display)) {
    bad('Display rules must be an object.');
    return out;
  }
  const extra = Object.keys(display).filter((k) => k !== 'v' && k !== 'rules');
  if (extra.length) bad('Display rules have unknown fields.');
  if (display.v !== DISPLAY_RULES_VERSION)
    bad(`Display rules version must be ${DISPLAY_RULES_VERSION}.`);
  const rules = display.rules;
  if (!Array.isArray(rules)) {
    bad('Display rules need a list of rules.');
    return out;
  }
  if (rules.length > MAX_DISPLAY_RULES)
    bad(`At most ${MAX_DISPLAY_RULES} display rules are allowed.`);
  const schedules = rules.filter((r) => isRecord(r) && r.type === 'schedule');
  const devices = rules.filter((r) => isRecord(r) && r.type === 'device');
  if (schedules.length > 1) bad('Only one schedule is allowed.');
  if (devices.length > 1) bad('Only one device rule is allowed.');
  if (schedules.length + devices.length !== rules.length)
    bad('Each display rule must be a schedule or a device rule.');

  for (const rule of schedules) {
    const r = rule as Record<string, unknown>;
    if (
      Object.keys(r).some(
        (k) => !['type', 'startsAt', 'endsAt', 'timezone'].includes(k),
      )
    )
      bad('A schedule has unknown fields.');
    const hasStart = r.startsAt !== undefined;
    const hasEnd = r.endsAt !== undefined;
    if (!hasStart && !hasEnd) {
      bad('A schedule needs a start, an end or both.');
      continue;
    }
    const start = hasStart ? parseInstant(r.startsAt) : null;
    const end = hasEnd ? parseInstant(r.endsAt) : null;
    let valid = true;
    if (hasStart && start === null) {
      bad(
        'The start must be an ISO date and time with an offset, such as 2026-12-01T09:00:00Z.',
      );
      valid = false;
    }
    if (hasEnd && end === null) {
      bad(
        'The end must be an ISO date and time with an offset, such as 2026-12-01T09:00:00Z.',
      );
      valid = false;
    }
    if (r.timezone !== undefined && !isKnownTimezone(r.timezone)) {
      bad('The schedule time zone is not a known time zone.');
      valid = false;
    }
    if (!valid) continue;
    if (start !== null && end !== null && end <= start) {
      out.problems.push({
        code: 'order',
        message: 'The schedule end must be after its start.',
      });
      continue;
    }
    if (schedules.length === 1) out.schedule = { startsAt: start, endsAt: end };
  }

  for (const rule of devices) {
    const r = rule as Record<string, unknown>;
    if (
      Object.keys(r).some(
        (k) => !['type', 'desktop', 'tablet', 'mobile'].includes(k),
      )
    )
      bad('A device rule has unknown fields.');
    const flags = [r.desktop, r.tablet, r.mobile];
    if (flags.some((f) => typeof f !== 'boolean')) {
      bad('A device rule needs true or false for desktop, tablet and mobile.');
      continue;
    }
    if (devices.length === 1 && flags.every((f) => f === false))
      out.hiddenEverywhere = true;
  }
  return out;
}
