import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { invalid } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { INDIAN_STATES } from '../orders/indian-states.js';
import { gstinStateCode, isValidGstin } from './gst.js';
import type {
  SaveTaxSettingsDto,
  TaxReportDto,
  TaxReportQueryDto,
  TaxReportRowDto,
  TaxSettingsDto,
} from './tax.dto.js';

const DAY = 86_400_000;
const MAX_REPORT_DAYS = 366;

const stateName = (code: string | null) =>
  INDIAN_STATES.find((s) => s.code === code)?.name ?? null;

const EMPTY: TaxSettingsDto = {
  configured: false,
  enabled: false,
  gstin: null,
  legalName: null,
  stateCode: null,
  stateName: null,
  pricesIncludeTax: false,
  defaultRateBps: 1800,
  chargesTaxable: true,
  chargesRateBps: 1800,
  updatedAt: null,
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class TaxService {
  constructor(private readonly db: DatabaseService) {}

  async settings(org: OrgContext): Promise<TaxSettingsDto> {
    return this.db.withUser(org.userId, async (tx) => {
      const r = rowsOf<{
        enabled: boolean;
        gstin: string | null;
        legal_name: string | null;
        state_code: string | null;
        prices_include_tax: boolean;
        default_rate_bps: number;
        charges_taxable: boolean;
        charges_rate_bps: number;
        updated_at: string | Date;
      }>(
        await tx.execute(sql`
          select enabled, gstin, legal_name, state_code, prices_include_tax, default_rate_bps, charges_taxable, charges_rate_bps, updated_at
          from public.tenant_tax_settings where tenant_id = ${org.tenantId}::uuid`),
      )[0];
      if (!r) return EMPTY;
      return {
        configured: true,
        enabled: r.enabled,
        gstin: r.gstin,
        legalName: r.legal_name,
        stateCode: r.state_code,
        stateName: stateName(r.state_code),
        pricesIncludeTax: r.prices_include_tax,
        defaultRateBps: r.default_rate_bps,
        chargesTaxable: r.charges_taxable,
        chargesRateBps: r.charges_rate_bps,
        updatedAt: new Date(r.updated_at),
      };
    });
  }

  async save(
    org: OrgContext,
    dto: SaveTaxSettingsDto,
  ): Promise<TaxSettingsDto> {
    const gstin = dto.gstin ?? null;
    const problems: Record<string, string> = {};
    if (gstin !== null && !isValidGstin(gstin))
      problems.gstin =
        'This is not a valid GSTIN. Check all 15 characters (the last one is a check character).';
    else if (gstin !== null && !stateName(gstinStateCode(gstin)))
      problems.gstin =
        'The first two digits of this GSTIN are not a state code.';
    if (dto.enabled && gstin === null)
      problems.gstin = 'Enter your GSTIN to charge GST.';
    if (Object.keys(problems).length > 0)
      throw invalid(
        'Please fix the highlighted fields.',
        problems,
        'TAX_SETTINGS_INVALID',
      );

    const state = gstin ? gstinStateCode(gstin) : null;
    await this.db.withUser(org.userId, (tx) =>
      tx.execute(sql`
        insert into public.tenant_tax_settings (tenant_id, enabled, gstin, legal_name, state_code, prices_include_tax, default_rate_bps,
          charges_taxable, charges_rate_bps, updated_at, updated_by)
        values (${org.tenantId}::uuid, ${dto.enabled}, ${gstin}, ${dto.legalName ?? null}, ${state}, ${dto.pricesIncludeTax},
          ${dto.defaultRateBps}, ${dto.chargesTaxable}, ${dto.chargesRateBps}, now(), ${org.userId}::uuid)
        on conflict (tenant_id) do update set enabled = ${dto.enabled}, gstin = ${gstin}, legal_name = ${dto.legalName ?? null},
          state_code = ${state}, prices_include_tax = ${dto.pricesIncludeTax}, default_rate_bps = ${dto.defaultRateBps},
          charges_taxable = ${dto.chargesTaxable}, charges_rate_bps = ${dto.chargesRateBps}, updated_at = now(), updated_by = ${org.userId}::uuid`),
    );
    return this.settings(org);
  }

  /** GST charged on orders placed in a period (not cancelled, failed or still unpaid), by rate. Reads what each order saved. */
  async report(org: OrgContext, q: TaxReportQueryDto): Promise<TaxReportDto> {
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date();
    const from = q.from
      ? new Date(`${q.from}T00:00:00Z`)
      : new Date(to.getTime() - 30 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw invalid(
        'Enter real dates.',
        { from: 'Enter a real date.' },
        'REPORT_RANGE_INVALID',
      );
    if (from.getTime() > to.getTime())
      throw invalid(
        'The start date is after the end date.',
        { from: 'Start on or before the end date.' },
        'REPORT_RANGE_INVALID',
      );
    if ((to.getTime() - from.getTime()) / DAY > MAX_REPORT_DAYS)
      throw invalid(
        `Choose a period of at most ${MAX_REPORT_DAYS} days.`,
        { to: `At most ${MAX_REPORT_DAYS} days.` },
        'REPORT_RANGE_INVALID',
      );
    const fromDay = isoDay(from);
    const toDay = isoDay(to);

    return this.db.withUser(org.userId, async (tx) => {
      // Days are shop days (India time): from the start of the first day to the end of the last.
      const inPeriod = sql`o.tenant_id = ${org.tenantId}::uuid
        and o.placed_at >= (${fromDay}::date)::timestamp at time zone 'Asia/Kolkata'
        and o.placed_at < ((${toDay}::date + 1))::timestamp at time zone 'Asia/Kolkata'
        and o.status in ('confirmed', 'processing', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered')`;
      const rows = rowsOf<{
        rate_bps: number;
        lines: number;
        taxable: number;
        cgst: number;
        sgst: number;
        igst: number;
        tax: number;
      }>(
        await tx.execute(sql`
          select l.rate_bps, count(*)::int as lines, coalesce(sum(l.taxable_minor), 0)::float8 as taxable,
            coalesce(sum(l.cgst_minor), 0)::float8 as cgst, coalesce(sum(l.sgst_minor), 0)::float8 as sgst,
            coalesce(sum(l.igst_minor), 0)::float8 as igst, coalesce(sum(l.tax_minor), 0)::float8 as tax
          from public.order_tax_lines l join public.orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
          where ${inPeriod} group by l.rate_bps order by l.rate_bps desc`),
      );
      const counts = rowsOf<{ orders: number; taxed: number }>(
        await tx.execute(sql`
          select count(*)::int as orders, count(*) filter (where o.tax_minor > 0)::int as taxed
          from public.orders o where ${inPeriod}`),
      )[0];
      const charges = rowsOf<{ tax: number }>(
        await tx.execute(sql`
          select coalesce(sum(l.tax_minor), 0)::float8 as tax
          from public.order_tax_lines l join public.orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
          where ${inPeriod} and l.kind in ('shipping', 'cod_fee')`),
      )[0];
      const byRate: TaxReportRowDto[] = rows.map((r) => ({
        rateBps: r.rate_bps,
        lines: r.lines,
        taxableMinor: Number(r.taxable),
        cgstMinor: Number(r.cgst),
        sgstMinor: Number(r.sgst),
        igstMinor: Number(r.igst),
        taxMinor: Number(r.tax),
      }));
      const sum = (pick: (r: TaxReportRowDto) => number) =>
        byRate.reduce((n, r) => n + pick(r), 0);
      return {
        from: fromDay,
        to: toDay,
        orders: counts.orders,
        taxedOrders: counts.taxed,
        byRate,
        totals: {
          rateBps: 0,
          lines: sum((r) => r.lines),
          taxableMinor: sum((r) => r.taxableMinor),
          cgstMinor: sum((r) => r.cgstMinor),
          sgstMinor: sum((r) => r.sgstMinor),
          igstMinor: sum((r) => r.igstMinor),
          taxMinor: sum((r) => r.taxMinor),
        },
        chargesTaxMinor: Number(charges.tax),
      };
    });
  }
}
