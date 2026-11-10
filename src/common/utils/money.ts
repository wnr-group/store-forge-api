/**
 * Money is stored as integer minor units (paise, cents...) in the store's currency.
 * Never use floats for arithmetic; convert only at the edges (forms in, display out).
 */

/** Number of decimal places the currency uses (INR/USD 2, JPY 0, KWD 3). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Parses a user-entered amount ("1,299.50") to minor units, or null if it isn't a valid non-negative amount. */
export function parseMoney(input: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const clean = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  if (frac.length > digits) return null;
  const minor =
    Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units to a plain editable string ("1299.50"), for form inputs. */
export function minorToInput(
  minor: number | null | undefined,
  currency: string,
): string {
  if (minor === null || minor === undefined) return '';
  const digits = currencyDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

export function formatMoney(
  minor: number,
  currency: string,
  locale = 'en-IN',
): string {
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/** Compact form for chart axes and stat cards: 1.2L / 3.4K style via Intl. */
export function formatMoneyCompact(
  minor: number,
  currency: string,
  locale = 'en-IN',
): string {
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(minor / 10 ** digits);
  } catch {
    return formatMoney(minor, currency, locale);
  }
}
