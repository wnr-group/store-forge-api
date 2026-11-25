import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import {
  itemKeyOf,
  type CheckoutTaxCalculator,
  type CheckoutTaxInput,
  type CheckoutTaxResult,
} from '../orders/checkout-hooks.js';
import { computeTax, type TaxableLine } from './gst.js';

const NO_TAX: CheckoutTaxResult = {
  regime: 'none',
  stateTaxKind: 'sgst',
  inclusive: false,
  sellerGstin: null,
  sellerStateCode: null,
  supplyStateCode: null,
  cgstMinor: 0,
  sgstMinor: 0,
  igstMinor: 0,
  taxMinor: 0,
  lines: [],
};

/**
 * Works out the GST of an order inside the checkout transaction, from the organization's own settings and the products' own rates
 * as the database holds them at that moment. Nothing about tax or price is taken from the browser. An organization that has not
 * turned tax on is charged none, exactly as before this existed.
 */
@Injectable()
export class CheckoutTaxService implements CheckoutTaxCalculator {
  async compute(tx: DbTx, input: CheckoutTaxInput): Promise<CheckoutTaxResult> {
    const s = rowsOf<{
      enabled: boolean;
      gstin: string | null;
      state_code: string | null;
      prices_include_tax: boolean;
      default_rate_bps: number;
      charges_taxable: boolean;
      charges_rate_bps: number;
    }>(
      await tx.execute(sql`
        select enabled, gstin, state_code, prices_include_tax, default_rate_bps, charges_taxable, charges_rate_bps
        from public.tenant_tax_settings where tenant_id = ${input.tenantId}::uuid`),
    )[0];
    if (!s?.enabled || !s.gstin || !s.state_code) return NO_TAX;

    const lines: (TaxableLine & { itemKey: string | null })[] = [];
    // A discount lowers what tax is charged on: it is shared across the items in proportion to their value.
    const itemsTotal = input.lines.reduce((n, l) => n + l.totalMinor, 0);
    let discountLeft = Math.min(input.discountMinor, itemsTotal);
    input.lines.forEach((l, i) => {
      const last = i === input.lines.length - 1;
      const share = last
        ? discountLeft
        : Math.min(
            discountLeft,
            Math.round((input.discountMinor * l.totalMinor) / itemsTotal),
          );
      discountLeft -= share;
      lines.push({
        key: itemKeyOf(l),
        itemKey: itemKeyOf(l),
        kind: 'item',
        description: l.name,
        hsnCode: l.hsnCode,
        amountMinor: l.totalMinor - share,
        rateBps: l.taxRateBps ?? s.default_rate_bps,
      });
    });
    if (s.charges_taxable) {
      lines.push({
        key: 'shipping',
        itemKey: null,
        kind: 'shipping',
        description: 'Delivery charge',
        hsnCode: '996812', // courier services (SAC)
        amountMinor: input.shippingMinor,
        rateBps: s.charges_rate_bps,
      });
      lines.push({
        key: 'cod_fee',
        itemKey: null,
        kind: 'cod_fee',
        description: 'Cash on delivery charge',
        hsnCode: '996812',
        amountMinor: input.codFeeMinor,
        rateBps: s.charges_rate_bps,
      });
    }

    const result = computeTax({
      supplierStateCode: s.state_code,
      supplyStateCode: input.destination.stateCode,
      inclusive: s.prices_include_tax,
      lines,
    });
    const itemKeys = new Map(lines.map((l) => [l.key, l.itemKey]));
    return {
      regime: result.regime,
      stateTaxKind: result.stateTaxKind,
      inclusive: s.prices_include_tax,
      sellerGstin: s.gstin,
      sellerStateCode: s.state_code,
      supplyStateCode: input.destination.stateCode,
      cgstMinor: result.cgstMinor,
      sgstMinor: result.sgstMinor,
      igstMinor: result.igstMinor,
      taxMinor: result.taxMinor,
      lines: result.lines.map((l) => ({
        ...l,
        itemKey: itemKeys.get(l.key) ?? null,
      })),
    };
  }
}
