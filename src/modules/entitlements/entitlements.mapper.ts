import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
} from '../../common/constants/plan-catalog.js';
import type { EntitlementsDto } from './entitlements.dto.js';
import type { Entitlements, LimitReport } from './entitlements.service.js';

/** One response shape for the tenant's own view and the Platform Admin's view of a tenant. */
export function toEntitlementsDto(
  e: Entitlements,
  limits: LimitReport[],
): EntitlementsDto {
  return {
    planCode: e.planCode,
    planName: e.planName,
    isUnrestricted: e.isUnrestricted,
    subscriptionStatus: e.subscriptionStatus,
    entitled: e.entitled,
    trialEndsAt: e.trialEndsAt,
    currentPeriodEnd: e.currentPeriodEnd,
    features: FEATURE_KEYS.map((key) => ({
      key,
      label: FEATURE_CATALOG[key].label,
      group: FEATURE_CATALOG[key].group,
      enabled: e.features[key].enabled,
      source: e.features[key].source,
    })),
    limits,
    attention: limits.filter(
      (l) => l.level === 'warning' || l.level === 'reached',
    ),
  };
}
