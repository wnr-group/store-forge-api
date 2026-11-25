import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../database/database.service.js';

/**
 * One page of a list AND the size of the whole list, from a single evaluation of the query: the total rides along as a window
 * count (`total_rows`). Asking for the page and then counting separately runs the whole query twice, which on a long list (and
 * with row level security checked per row) is most of the time. A page past the end has no rows to carry the count, so only then
 * is it asked for on its own.
 *
 * `pageQuery` must select `count(*) over ()::int as total_rows` next to its columns, ordered and limited.
 */
export async function pageWithTotal<T extends { total_rows: number }>(
  tx: DbTx,
  pageQuery: SQL,
  page: number,
  countQuery: SQL,
): Promise<{ rows: T[]; total: number }> {
  const rows = rowsOf<T>(await tx.execute(pageQuery));
  if (rows.length > 0) return { rows, total: rows[0].total_rows };
  if (page === 1) return { rows, total: 0 };
  return {
    rows,
    total: rowsOf<{ n: number }>(await tx.execute(countQuery))[0].n,
  };
}

/** Kept so callers can build the window count the same way everywhere. */
export const WINDOW_TOTAL = sql`count(*) over ()::int as total_rows`;
