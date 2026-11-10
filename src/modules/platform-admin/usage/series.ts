export type SeriesBucket = 'day' | 'week' | 'month';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The date range for the chart, with defaults and limits applied: the last 90 days when nothing is chosen, swapped if the
 * dates are backwards, at most about 3 years, and a bucket size (day, week, month) that keeps the chart readable.
 */
export function resolveSeriesRange(
  from: string,
  to: string,
  now = new Date(),
): { from: string; to: string; bucket: SeriesBucket } {
  let end = to
    ? new Date(`${to}T00:00:00Z`)
    : new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
  let start = from
    ? new Date(`${from}T00:00:00Z`)
    : new Date(end.getTime() - 89 * DAY);
  if (start > end) [start, end] = [end, start];
  if (end.getTime() - start.getTime() > 1095 * DAY)
    start = new Date(end.getTime() - 1095 * DAY);
  const days = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  return {
    from: iso(start),
    to: iso(end),
    bucket: days <= 62 ? 'day' : days <= 365 ? 'week' : 'month',
  };
}
