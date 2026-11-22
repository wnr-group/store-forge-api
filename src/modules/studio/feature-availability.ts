import { sql } from 'drizzle-orm';
import { rowsOf, type DbTx } from '../../database/database.service.js';

/** Features that stay unavailable until legal approval is recorded (the same keys the attestation types use). */
export const STUDIO_FEATURE_KEYS = ['badge_upload', 'review_import'] as const;
export type StudioFeatureKey = (typeof STUDIO_FEATURE_KEYS)[number];
export type FeatureAvailability = 'available' | 'unavailable';

/**
 * The legal gate. A feature is `available` only when a feature_approvals row exists for it whose wording is still
 * approved (public.is_feature_approved). No row, a retired wording or a missing feature all mean `unavailable`.
 * Nothing creates approval rows except a Platform Admin recording one.
 */
export async function featureAvailability(
  tx: DbTx,
  featureKey: string,
): Promise<FeatureAvailability> {
  const rows = rowsOf<{ ok: boolean | null }>(
    await tx.execute(
      sql`select public.is_feature_approved(${featureKey}) as ok`,
    ),
  );
  return rows[0]?.ok === true ? 'available' : 'unavailable';
}
