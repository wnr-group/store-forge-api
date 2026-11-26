/**
 * Pure discount rules. No database, no clock of its own: everything a decision needs is passed in, so every rule is testable
 * and the checkout, the public validation and the dashboard all apply exactly the same ones.
 *
 * Money is integer paise throughout. A percentage `value` is basis points (1000 = 10%); a fixed `value` is paise.
 * A discount applies to the ELIGIBLE items only (all of the cart, or the products / collections the code is limited to). It is
 * never applied to delivery, cash-on-delivery charges or tax: those are worked out after it, on the discounted amount.
 */
export type DiscountKind = 'percentage' | 'fixed';
export type DiscountScope = 'all' | 'products' | 'collections';

export interface CampaignWindow {
  status: 'draft' | 'active' | 'paused' | 'completed';
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface DiscountRule {
  id: string;
  code: string;
  kind: DiscountKind;
  value: number;
  minSubtotalMinor: number;
  maxDiscountMinor: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  appliesTo: DiscountScope;
  isActive: boolean;
  /** The campaign the code belongs to, if any. A code of a campaign works only while the campaign is live. */
  campaign: CampaignWindow | null;
}

/** What the database says about use so far. `byCustomer` is null when the shopper's email is not known yet. */
export interface DiscountUsage {
  inUse: number;
  byCustomer: number | null;
}

export interface DiscountLine {
  productId: string;
  totalMinor: number;
}

export interface DiscountScopeSets {
  /** Products the code is limited to, directly. */
  productIds: ReadonlySet<string>;
  /** Products that belong to the collections the code is limited to. */
  collectionProductIds: ReadonlySet<string>;
}

export const DISCOUNT_REJECTIONS = [
  'NOT_FOUND',
  'INACTIVE',
  'NOT_STARTED',
  'EXPIRED',
  'CAMPAIGN_INACTIVE',
  'USAGE_LIMIT',
  'CUSTOMER_LIMIT',
  'MIN_SUBTOTAL',
  'NO_ELIGIBLE_ITEMS',
] as const;
export type DiscountRejection = (typeof DISCOUNT_REJECTIONS)[number];

export type DiscountDecision =
  | { ok: true; discountMinor: number; eligibleSubtotalMinor: number }
  | {
      ok: false;
      reason: DiscountRejection;
      /** MIN_SUBTOTAL: what the eligible items must add up to. */
      minSubtotalMinor?: number;
    };

export const REJECTION_MESSAGES: Record<DiscountRejection, string> = {
  NOT_FOUND: 'This discount code is not valid.',
  INACTIVE: 'This discount code is not valid.',
  NOT_STARTED: 'This discount code is not active yet.',
  EXPIRED: 'This discount code has expired.',
  CAMPAIGN_INACTIVE: 'This discount code is not available right now.',
  USAGE_LIMIT: 'This discount code has reached its usage limit.',
  CUSTOMER_LIMIT:
    'You have already used this discount code the allowed number of times.',
  MIN_SUBTOTAL:
    'Your cart does not reach the minimum amount for this discount code.',
  NO_ELIGIBLE_ITEMS:
    'This discount code does not apply to the items in your cart.',
};

/** A campaign is live when it is active and `now` is inside its window. */
export function campaignIsLive(c: CampaignWindow, now: Date): boolean {
  if (c.status !== 'active') return false;
  if (c.startsAt && c.startsAt.getTime() > now.getTime()) return false;
  if (c.endsAt && c.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/** The items a code applies to. */
export function eligibleLines<T extends DiscountLine>(
  rule: Pick<DiscountRule, 'appliesTo'>,
  lines: readonly T[],
  sets: DiscountScopeSets,
): T[] {
  if (rule.appliesTo === 'all') return [...lines];
  const ids =
    rule.appliesTo === 'products' ? sets.productIds : sets.collectionProductIds;
  return lines.filter((l) => ids.has(l.productId));
}

/** The amount taken off `eligibleSubtotalMinor` by this code, never more than that subtotal. */
export function discountAmount(
  rule: Pick<DiscountRule, 'kind' | 'value' | 'maxDiscountMinor'>,
  eligibleSubtotalMinor: number,
): number {
  let amount =
    rule.kind === 'percentage'
      ? Math.floor((eligibleSubtotalMinor * rule.value) / 10_000)
      : rule.value;
  if (rule.kind === 'percentage' && rule.maxDiscountMinor !== null)
    amount = Math.min(amount, rule.maxDiscountMinor);
  return Math.max(0, Math.min(amount, eligibleSubtotalMinor));
}

/** Decides whether `rule` may be applied to `lines` now, and for how much. The first failing rule is reported. */
export function evaluateDiscount(
  rule: DiscountRule,
  lines: readonly DiscountLine[],
  sets: DiscountScopeSets,
  usage: DiscountUsage,
  now: Date,
): DiscountDecision {
  if (!rule.isActive) return { ok: false, reason: 'INACTIVE' };
  if (rule.startsAt && rule.startsAt.getTime() > now.getTime())
    return { ok: false, reason: 'NOT_STARTED' };
  if (rule.expiresAt && rule.expiresAt.getTime() <= now.getTime())
    return { ok: false, reason: 'EXPIRED' };
  if (rule.campaign && !campaignIsLive(rule.campaign, now))
    return { ok: false, reason: 'CAMPAIGN_INACTIVE' };
  if (rule.usageLimit !== null && usage.inUse >= rule.usageLimit)
    return { ok: false, reason: 'USAGE_LIMIT' };
  if (
    rule.perCustomerLimit !== null &&
    usage.byCustomer !== null &&
    usage.byCustomer >= rule.perCustomerLimit
  )
    return { ok: false, reason: 'CUSTOMER_LIMIT' };

  const eligible = eligibleLines(rule, lines, sets);
  const eligibleSubtotalMinor = eligible.reduce((n, l) => n + l.totalMinor, 0);
  if (eligible.length === 0 || eligibleSubtotalMinor <= 0)
    return { ok: false, reason: 'NO_ELIGIBLE_ITEMS' };
  if (eligibleSubtotalMinor < rule.minSubtotalMinor)
    return {
      ok: false,
      reason: 'MIN_SUBTOTAL',
      minSubtotalMinor: rule.minSubtotalMinor,
    };

  return {
    ok: true,
    discountMinor: discountAmount(rule, eligibleSubtotalMinor),
    eligibleSubtotalMinor,
  };
}

/** What the dashboard shows for a code, from its own settings and use. */
export type DiscountStatus =
  | 'active'
  | 'disabled'
  | 'scheduled'
  | 'expired'
  | 'exhausted'
  | 'campaign_inactive';

export function discountStatus(
  rule: DiscountRule,
  inUse: number,
  now: Date,
): DiscountStatus {
  if (!rule.isActive) return 'disabled';
  if (rule.startsAt && rule.startsAt.getTime() > now.getTime())
    return 'scheduled';
  if (rule.expiresAt && rule.expiresAt.getTime() <= now.getTime())
    return 'expired';
  if (rule.usageLimit !== null && inUse >= rule.usageLimit) return 'exhausted';
  if (rule.campaign && !campaignIsLive(rule.campaign, now))
    return 'campaign_inactive';
  return 'active';
}

export type CampaignPhase = 'draft' | 'scheduled' | 'live' | 'paused' | 'ended';

/** What a campaign is doing right now: an active campaign past its end date has ended, one before its start is scheduled. */
export function campaignPhase(c: CampaignWindow, now: Date): CampaignPhase {
  if (c.status === 'draft') return 'draft';
  if (c.status === 'completed') return 'ended';
  if (c.endsAt && c.endsAt.getTime() <= now.getTime()) return 'ended';
  if (c.status === 'paused') return 'paused';
  if (c.startsAt && c.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

const CAMPAIGN_NEXT: Record<
  CampaignWindow['status'],
  readonly CampaignWindow['status'][]
> = {
  draft: ['active', 'completed'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: [],
};

/** Whether a campaign may move from `from` to `to` (a completed campaign never restarts). */
export const canMoveCampaign = (
  from: CampaignWindow['status'],
  to: CampaignWindow['status'],
) => CAMPAIGN_NEXT[from].includes(to);

/** The key per-customer limits count by: the email, lower-cased (the order always has one). */
export const customerKeyOf = (email: string) => email.trim().toLowerCase();

/** Codes are stored and compared upper-case. */
export const normalizeCode = (code: string) => code.trim().toUpperCase();
