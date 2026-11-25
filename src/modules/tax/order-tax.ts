import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type { OrderTaxDto } from './tax.dto.js';

/** The tax saved with an order, read back exactly as it was written (never recalculated from today's settings). */
export async function loadOrderTax(
  tx: DbTx,
  tenantId: string,
  orderId: string,
): Promise<OrderTaxDto> {
  const o = rowsOf<{
    tax_regime: string;
    state_tax_kind: string;
    tax_inclusive: boolean;
    seller_gstin: string | null;
    supply_state_code: string | null;
    cgst_minor: number;
    sgst_minor: number;
    igst_minor: number;
    tax_minor: number;
  }>(
    await tx.execute(sql`
      select tax_regime, state_tax_kind, tax_inclusive, seller_gstin, supply_state_code,
        cgst_minor::float8 as cgst_minor, sgst_minor::float8 as sgst_minor, igst_minor::float8 as igst_minor, tax_minor::float8 as tax_minor
      from public.orders where id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid`),
  )[0];
  const lines = rowsOf<{
    kind: string;
    description: string;
    hsn_code: string | null;
    taxable_minor: number;
    rate_bps: number;
    cgst_minor: number;
    sgst_minor: number;
    igst_minor: number;
    tax_minor: number;
  }>(
    await tx.execute(sql`
      select kind, description, hsn_code, taxable_minor::float8 as taxable_minor, rate_bps,
        cgst_minor::float8 as cgst_minor, sgst_minor::float8 as sgst_minor, igst_minor::float8 as igst_minor, tax_minor::float8 as tax_minor
      from public.order_tax_lines where order_id = ${orderId}::uuid and tenant_id = ${tenantId}::uuid
      order by sort_order, id`),
  );
  return {
    regime: o?.tax_regime ?? 'none',
    stateTaxKind: o?.state_tax_kind ?? 'sgst',
    inclusive: o?.tax_inclusive ?? false,
    sellerGstin: o?.seller_gstin ?? null,
    placeOfSupplyStateCode: o?.supply_state_code ?? null,
    cgstMinor: Number(o?.cgst_minor ?? 0),
    sgstMinor: Number(o?.sgst_minor ?? 0),
    igstMinor: Number(o?.igst_minor ?? 0),
    taxMinor: Number(o?.tax_minor ?? 0),
    lines: lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      hsnCode: l.hsn_code,
      taxableMinor: Number(l.taxable_minor),
      rateBps: l.rate_bps,
      cgstMinor: Number(l.cgst_minor),
      sgstMinor: Number(l.sgst_minor),
      igstMinor: Number(l.igst_minor),
      taxMinor: Number(l.tax_minor),
    })),
  };
}
