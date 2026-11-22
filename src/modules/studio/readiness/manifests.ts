import bundle from './manifest-bundle.generated.json' with { type: 'json' };
import type { ReadinessManifest } from './types.js';

/** The frontend-generated component manifests (copied, not computed). A drift test compares this file with the frontend's. */
export const MANIFEST_BUNDLE = bundle;

export const manifestKey = (kind: string, id: string) => `${kind}:${id}`;

function toReadinessManifest(m: Record<string, unknown>): ReadinessManifest {
  const legal = (m.legal ?? {}) as { required?: boolean; featureKey?: string };
  return {
    kind: m.kind as 'section' | 'block',
    id: String(m.id),
    availability: m.availability as ReadinessManifest['availability'],
    requiresPurchaseFlow: m.requiresPurchaseFlow === true,
    legal: { required: legal.required === true, featureKey: legal.featureKey },
  };
}

export function loadManifests(
  manifests: readonly Record<string, unknown>[] = MANIFEST_BUNDLE.manifests,
): Map<string, ReadinessManifest> {
  const out = new Map<string, ReadinessManifest>();
  for (const m of manifests) {
    const r = toReadinessManifest(m);
    out.set(manifestKey(r.kind, r.id), r);
  }
  return out;
}
