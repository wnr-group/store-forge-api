import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { sql, type SQL } from 'drizzle-orm';
import { invalid } from '../app.exception.js';

const DAY = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `?from=2026-11-01&to=2026-11-30`: whole days in the store's time zone, both ends included. */
export class DateRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'First day (YYYY-MM-DD).',
  })
  @IsOptional()
  @Matches(DAY_PATTERN, { message: 'Use a date like 2026-11-01.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Last day (YYYY-MM-DD), included.',
  })
  @IsOptional()
  @Matches(DAY_PATTERN, { message: 'Use a date like 2026-11-30.' })
  to?: string;
}

export interface DayRange {
  /** YYYY-MM-DD, first day included. */
  from: string;
  /** YYYY-MM-DD, last day included. */
  to: string;
  days: number;
}

const isRealDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Today's date in `timeZone` as YYYY-MM-DD. */
export const todayIn = (timeZone: string, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));

/**
 * Turns the query into a checked range. Without `to` it ends today (in `timeZone`); without `from` it starts `defaultDays - 1`
 * days before `to`. Refuses unreal dates, a range that ends before it starts and one longer than `maxDays`.
 */
export function resolveDayRange(
  q: DateRangeQueryDto,
  timeZone: string,
  options: { defaultDays?: number; maxDays?: number } = {},
): DayRange {
  const { defaultDays = 30, maxDays = 366 } = options;
  const problems: Record<string, string> = {};
  if (q.from && !isRealDay(q.from)) problems.from = 'Enter a real date.';
  if (q.to && !isRealDay(q.to)) problems.to = 'Enter a real date.';
  if (Object.keys(problems).length > 0)
    throw invalid('Enter real dates.', problems, 'DATE_RANGE_INVALID');
  const to = q.to ?? todayIn(timeZone);
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  const from =
    q.from ??
    new Date(toMs - (defaultDays - 1) * DAY).toISOString().slice(0, 10);
  const days =
    Math.round((toMs - new Date(`${from}T00:00:00Z`).getTime()) / DAY) + 1;
  if (days < 1)
    throw invalid(
      'The end date is before the start date.',
      { to: 'Choose a date on or after the start.' },
      'DATE_RANGE_INVALID',
    );
  if (days > maxDays)
    throw invalid(
      `Choose at most ${maxDays} days.`,
      { from: `Choose at most ${maxDays} days.` },
      'DATE_RANGE_TOO_LONG',
    );
  return { from, to, days };
}

/** `column` falls inside the range, days counted in `timeZone`. `column` must be a trusted SQL fragment, never user input. */
export const withinRange = (column: SQL, range: DayRange, timeZone: string) =>
  sql`${column} >= (${range.from}::date)::timestamp at time zone ${timeZone}
      and ${column} < ((${range.to}::date + 1))::timestamp at time zone ${timeZone}`;
