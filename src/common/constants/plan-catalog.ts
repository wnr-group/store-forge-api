/**
 * What a subscription plan can switch on or limit. The catalog lists the CAPABILITIES StoreForge has (they are code, so
 * they live here); which plan includes which, and every number, is data that Platform Admins edit (tables `plan_features`
 * and `plan_limits`). Nothing in this file says what a plan called "Starter" contains.
 *
 * Only things that exist in StoreForge are listed. Custom domains and API request metering are not features of the
 * product today, so they are deliberately absent rather than offered as switches that do nothing.
 */
export const FEATURE_KEYS = [
  'discount_codes',
  'abandoned_cart_recovery',
  'marketing_campaigns',
  'advanced_reports',
  'google_analytics',
  'meta_pixel',
  'multiple_staff',
  'shipping_integrations',
  'online_payments',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_CATALOG: Record<
  FeatureKey,
  { label: string; description: string; group: string }
> = {
  discount_codes: {
    label: 'Discount codes and coupons',
    description: 'Create discount codes and automatic discounts.',
    group: 'Marketing',
  },
  abandoned_cart_recovery: {
    label: 'Abandoned cart recovery',
    description: 'Track abandoned carts and send recovery messages.',
    group: 'Marketing',
  },
  marketing_campaigns: {
    label: 'Marketing campaigns',
    description: 'Create campaigns and measure their results.',
    group: 'Marketing',
  },
  advanced_reports: {
    label: 'Advanced reports',
    description: 'Sales, revenue, product and customer analytics.',
    group: 'Analytics',
  },
  google_analytics: {
    label: 'Google Analytics',
    description: 'Connect Google Analytics 4 to the storefront.',
    group: 'Integrations',
  },
  meta_pixel: {
    label: 'Meta Pixel',
    description: 'Connect a Meta Pixel to the storefront.',
    group: 'Integrations',
  },
  multiple_staff: {
    label: 'Staff accounts',
    description: 'Add team members besides the Owner.',
    group: 'Team',
  },
  shipping_integrations: {
    label: 'Shipping carrier integrations',
    description: 'Connect carrier accounts such as Shiprocket or Delhivery.',
    group: 'Integrations',
  },
  online_payments: {
    label: 'Online payments',
    description: 'Take online payments through the store Razorpay account.',
    group: 'Integrations',
  },
};

export const LIMIT_KEYS = [
  'products',
  'staff_accounts',
  'orders_per_month',
  'storage_bytes',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_CATALOG: Record<
  LimitKey,
  {
    label: string;
    description: string;
    unit: 'count' | 'bytes';
    /** Whether going past the hard limit is refused. Orders are only reported: a shopper is never turned away at checkout. */
    enforced: boolean;
  }
> = {
  products: {
    label: 'Products',
    description: 'Products in the catalog.',
    unit: 'count',
    enforced: true,
  },
  staff_accounts: {
    label: 'Staff accounts',
    description: 'Team members besides the Owner.',
    unit: 'count',
    enforced: true,
  },
  orders_per_month: {
    label: 'Orders per month',
    description:
      'Orders placed in a calendar month (UTC). Reported and warned about, never used to refuse an order.',
    unit: 'count',
    enforced: false,
  },
  storage_bytes: {
    label: 'Storage',
    description:
      'Uploaded files such as product images. New uploads are refused once the hard limit is reached.',
    unit: 'bytes',
    enforced: true,
  },
};

export const isFeatureKey = (v: unknown): v is FeatureKey =>
  typeof v === 'string' && (FEATURE_KEYS as readonly string[]).includes(v);
export const isLimitKey = (v: unknown): v is LimitKey =>
  typeof v === 'string' && (LIMIT_KEYS as readonly string[]).includes(v);

/** A limit with no number is unlimited. `soft` warns, `hard` blocks; both are optional. */
export type LimitValue = { soft: number | null; hard: number | null };

export const PLAN_STATUSES = ['active', 'inactive'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Which feature an integration provider needs (the provider codes of modules/integrations). */
export const PROVIDER_FEATURE: Record<string, FeatureKey> = {
  ga4: 'google_analytics',
  meta_pixel: 'meta_pixel',
};

/** How close a number is to its limits. "reached" = at or past the hard limit; "warning" = at or past the soft limit or 80% of the hard one. */
export type LimitLevel = 'ok' | 'warning' | 'reached';
export const WARNING_RATIO_NUM = 4;
export const WARNING_RATIO_DEN = 5;

export function limitLevel(used: number, limit: LimitValue): LimitLevel {
  if (limit.hard !== null && used >= limit.hard) return 'reached';
  if (limit.soft !== null && used >= limit.soft) return 'warning';
  if (
    limit.hard !== null &&
    used * WARNING_RATIO_DEN >= limit.hard * WARNING_RATIO_NUM
  )
    return 'warning';
  return 'ok';
}

/** Share of the hard limit used, as a whole percent; null when there is no hard limit. */
export const limitPercent = (used: number, hard: number | null) =>
  hard === null ? null : hard === 0 ? 100 : Math.round((used * 100) / hard);
