/**
 * Indian GST, as pure functions: no database, no clock, nothing to mock.
 *
 * Money is integer paise and every division rounds half up, so the same inputs always give the same paise. Tax is worked out line
 * by line (each product, then shipping, then the cash-on-delivery charge) and the order's tax is the SUM of its lines, so what is
 * saved on the order always adds up exactly.
 *
 * Which tax applies: when the seller's state and the place of supply (the delivery state, for goods) are the same, the tax is
 * CGST + SGST (UTGST in union territories without a legislature), half each; otherwise it is IGST.
 */

/**
 * The GST rates a line may carry, in basis points (1800 = 18%). Current law and the Owner's product classification decide the
 * right rate for a product: StoreForge only checks that the rate is a real GST rate, it does not classify products.
 */
export const GST_RATES_BPS = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;

/** Union territories without a legislature charge UTGST in place of SGST: Chandigarh, Dadra & Nagar Haveli and Daman & Diu, Lakshadweep, Andaman & Nicobar, Ladakh. */
export const UTGST_STATE_CODES: readonly string[] = [
  '04',
  '26',
  '31',
  '35',
  '38',
];

export const isGstRate = (bps: number): boolean =>
  (GST_RATES_BPS as readonly number[]).includes(bps);

export const formatRate = (bps: number): string =>
  `${Number((bps / 100).toFixed(2))}%`;

/** HSN (goods) or SAC (services) code: 4, 6 or 8 digits. */
export const isHsnCode = (value: string): boolean =>
  /^(\d{4}|\d{6}|\d{8})$/.test(value);

// --- GSTIN -----------------------------------------------------------------------------------------------------------------

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** The check character of a GSTIN (a mod-36 checksum over its first 14 characters). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** Whether this is a well-formed GSTIN with a correct check character (it does not prove the registration exists). */
export function isValidGstin(value: string): boolean {
  if (!GSTIN_SHAPE.test(value)) return false;
  return gstinCheckChar(value.slice(0, 14)) === value[14];
}

export const gstinStateCode = (gstin: string): string => gstin.slice(0, 2);

// --- Arithmetic ------------------------------------------------------------------------------------------------------------

/** n / d rounded half up, for non-negative integers. */
export const divRound = (n: number, d: number): number =>
  Math.floor((2 * n + d) / (2 * d));

// --- The calculation -------------------------------------------------------------------------------------------------------

export type TaxLineKind = 'item' | 'shipping' | 'cod_fee';
export type TaxRegime = 'none' | 'intra' | 'inter';

export interface TaxableLine {
  /** Echoed back so the caller can match results to its own lines. */
  key: string;
  kind: TaxLineKind;
  description: string;
  hsnCode: string | null;
  /** What the shopper pays for this line (tax included when `inclusive`). */
  amountMinor: number;
  rateBps: number;
}

export interface TaxedLine extends TaxableLine {
  /** The value the tax is charged on (the amount without the tax). */
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  taxMinor: number;
}

export interface TaxInput {
  /** The seller's state (from the GSTIN) and where the goods are delivered. */
  supplierStateCode: string;
  supplyStateCode: string;
  /** Prices already include the tax (the tax is taken out of them) instead of being added on top. */
  inclusive: boolean;
  lines: readonly TaxableLine[];
}

export interface TaxResult {
  regime: Exclude<TaxRegime, 'none'>;
  /** `utgst` replaces `sgst` in union territories without a legislature. */
  stateTaxKind: 'sgst' | 'utgst';
  lines: TaxedLine[];
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  taxMinor: number;
}

export function computeTax(input: TaxInput): TaxResult {
  const intra = input.supplierStateCode === input.supplyStateCode;
  const lines: TaxedLine[] = [];
  for (const line of input.lines) {
    if (line.amountMinor <= 0) continue;
    const rate = line.rateBps;
    // "Rate over (100% + rate)" takes the tax out of a price that has it; "rate over 100%" adds it to one that does not.
    const denominator = input.inclusive ? 10000 + rate : 10000;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    if (intra) {
      const half = divRound(line.amountMinor * rate, 2 * denominator);
      cgst = half;
      sgst = half;
    } else {
      igst = divRound(line.amountMinor * rate, denominator);
    }
    const tax = cgst + sgst + igst;
    lines.push({
      ...line,
      taxableMinor: input.inclusive ? line.amountMinor - tax : line.amountMinor,
      cgstMinor: cgst,
      sgstMinor: sgst,
      igstMinor: igst,
      taxMinor: tax,
    });
  }
  const sum = (pick: (l: TaxedLine) => number) =>
    lines.reduce((n, l) => n + pick(l), 0);
  return {
    regime: intra ? 'intra' : 'inter',
    stateTaxKind: UTGST_STATE_CODES.includes(input.supplyStateCode)
      ? 'utgst'
      : 'sgst',
    lines,
    cgstMinor: sum((l) => l.cgstMinor),
    sgstMinor: sum((l) => l.sgstMinor),
    igstMinor: sum((l) => l.igstMinor),
    taxMinor: sum((l) => l.taxMinor),
  };
}
