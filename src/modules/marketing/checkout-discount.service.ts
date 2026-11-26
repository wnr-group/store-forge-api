import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';
import type {
  CheckoutDiscountInput,
  CheckoutDiscountResult,
  CheckoutDiscounts,
} from '../orders/checkout-hooks.js';
import {
  customerKeyOf,
  evaluateDiscount,
  normalizeCode,
  REJECTION_MESSAGES,
  type DiscountRejection,
  type DiscountRule,
  type DiscountScopeSets,
} from './discount-rules.js';

interface RuleRow {
  id: string;
  code: string;
  kind: 'percentage' | 'fixed';
  value: number;
  min_subtotal_minor: number;
  max_discount_minor: number | null;
  starts_at: string | Date | null;
  expires_at: string | Date | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  applies_to: 'all' | 'products' | 'collections';
  is_active: boolean;
  campaign_status: 'draft' | 'active' | 'paused' | 'completed' | null;
  campaign_starts_at: string | Date | null;
  campaign_ends_at: string | Date | null;
}

const date = (v: string | Date | null) => (v ? new Date(v) : null);

export const ruleFromRow = (r: RuleRow): DiscountRule => ({
  id: r.id,
  code: r.code,
  kind: r.kind,
  value: Number(r.value),
  minSubtotalMinor: Number(r.min_subtotal_minor),
  maxDiscountMinor:
    r.max_discount_minor === null ? null : Number(r.max_discount_minor),
  startsAt: date(r.starts_at),
  expiresAt: date(r.expires_at),
  usageLimit: r.usage_limit,
  perCustomerLimit: r.per_customer_limit,
  appliesTo: r.applies_to,
  isActive: r.is_active,
  campaign: r.campaign_status
    ? {
        status: r.campaign_status,
        startsAt: date(r.campaign_starts_at),
        endsAt: date(r.campaign_ends_at),
      }
    : null,
});

/** The columns `ruleFromRow` reads, from `discount_codes d` left-joined to `promotional_campaigns c`. */
export const RULE_COLUMNS = sql.raw(`
  d.id, d.code, d.kind, d.value::float8 as value, d.min_subtotal_minor::float8 as min_subtotal_minor,
  d.max_discount_minor::float8 as max_discount_minor, d.starts_at, d.expires_at, d.usage_limit, d.per_customer_limit,
  d.applies_to, d.is_active, c.status as campaign_status, c.starts_at as campaign_starts_at, c.ends_at as campaign_ends_at`);

const rejected = (
  reason: DiscountRejection,
  extra: { minSubtotalMinor?: number } = {},
): CheckoutDiscountResult => ({
  ok: false,
  reason,
  message: REJECTION_MESSAGES[reason],
  ...extra,
});

/**
 * Applies a tenant's discount code at checkout. The cart's lines arrive already priced by the server from the catalog, so
 * nothing the browser says about price or amount is ever used here: only the code text and the shopper's email.
 * It runs in the checkout transaction (role `storeforge_checkout`, pinned to one tenant), so it can only ever see that
 * tenant's codes.
 */
@Injectable()
export class CheckoutDiscountService implements CheckoutDiscounts {
  async resolve(
    tx: DbTx,
    input: CheckoutDiscountInput,
  ): Promise<CheckoutDiscountResult> {
    const code = normalizeCode(input.code);
    const row = rowsOf<RuleRow>(
      await tx.execute(sql`
        select ${RULE_COLUMNS}
        from public.discount_codes d
        left join public.promotional_campaigns c on c.tenant_id = d.tenant_id and c.id = d.campaign_id
        where d.tenant_id = ${input.tenantId}::uuid and d.code = ${code}`),
    )[0];
    // An unknown code and a disabled one look the same to a shopper.
    if (!row) return rejected('NOT_FOUND');
    const rule = ruleFromRow(row);

    const customerKey = input.customerEmail
      ? customerKeyOf(input.customerEmail)
      : '';
    const usage = rowsOf<{ in_use: number; by_customer: number }>(
      await tx.execute(
        sql`select in_use, by_customer from public.discount_usage(${input.tenantId}::uuid, ${rule.id}::uuid, ${customerKey})`,
      ),
    )[0] ?? { in_use: 0, by_customer: 0 };

    const decision = evaluateDiscount(
      rule,
      input.lines,
      await this.scopeSets(tx, input.tenantId, rule),
      {
        inUse: usage.in_use,
        byCustomer: input.customerEmail ? usage.by_customer : null,
      },
      new Date(),
    );
    if (!decision.ok)
      return rejected(
        decision.reason,
        decision.minSubtotalMinor === undefined
          ? {}
          : { minSubtotalMinor: decision.minSubtotalMinor },
      );
    return {
      ok: true,
      discountId: rule.id,
      code: rule.code,
      discountMinor: decision.discountMinor,
      eligibleSubtotalMinor: decision.eligibleSubtotalMinor,
    };
  }

  async redeem(
    tx: DbTx,
    input: {
      tenantId: string;
      discountId: string;
      orderId: string;
      customerEmail: string;
      discountMinor: number;
    },
  ): Promise<{ reason: string; message: string } | null> {
    const status = rowsOf<{ r: string }>(
      await tx.execute(sql`
        select public.redeem_discount(${input.tenantId}::uuid, ${input.discountId}::uuid, ${input.orderId}::uuid,
          ${customerKeyOf(input.customerEmail)}, ${input.discountMinor}) as r`),
    )[0].r;
    if (status === 'ok') return null;
    const reason: DiscountRejection =
      status === 'usage_limit'
        ? 'USAGE_LIMIT'
        : status === 'customer_limit'
          ? 'CUSTOMER_LIMIT'
          : status === 'expired'
            ? 'EXPIRED'
            : status === 'not_started'
              ? 'NOT_STARTED'
              : 'INACTIVE';
    return { reason, message: REJECTION_MESSAGES[reason] };
  }

  /** Products a scoped code is limited to: chosen directly, or through the collections chosen. */
  private async scopeSets(
    tx: DbTx,
    tenantId: string,
    rule: DiscountRule,
  ): Promise<DiscountScopeSets> {
    if (rule.appliesTo === 'all')
      return { productIds: new Set(), collectionProductIds: new Set() };
    const productIds = new Set<string>();
    const collectionProductIds = new Set<string>();
    if (rule.appliesTo === 'products') {
      for (const r of rowsOf<{ product_id: string }>(
        await tx.execute(sql`
          select product_id from public.discount_code_targets
          where tenant_id = ${tenantId}::uuid and discount_id = ${rule.id}::uuid and product_id is not null`),
      ))
        productIds.add(r.product_id);
    } else {
      for (const r of rowsOf<{ product_id: string }>(
        await tx.execute(sql`
          select cp.product_id from public.collection_products cp
          join public.discount_code_targets t on t.tenant_id = cp.tenant_id and t.collection_id = cp.collection_id
          where t.tenant_id = ${tenantId}::uuid and t.discount_id = ${rule.id}::uuid`),
      ))
        collectionProductIds.add(r.product_id);
    }
    return { productIds, collectionProductIds };
  }
}
