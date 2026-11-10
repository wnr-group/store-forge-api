// GENERATED from wnr-group/store-forge lib/templates/engine/tenant-cache.ts. DO NOT EDIT.

/** Most tenants whose compiled schema is kept per cache; the least recently used one is evicted. */
export const MAX_CACHED_TENANTS = 32;

/**
 * Small per-tenant LRU shared by every compiled schema that depends on the tenant (it decides which image paths pass).
 * `byTenant` is keyed by tenant id, with "" meaning none, so a schema built for one tenant is never reused for another
 * or for "no tenant". Map insertion order is the recency order: a hit is moved to the end, and a miss that fills the map
 * evicts the first (least recently used) entry.
 */
export function getForTenant<T>(byTenant: Map<string, T>, tenantId: string | undefined, build: () => T): T {
  const key = tenantId ?? "";
  let cached = byTenant.get(key);
  if (cached !== undefined) {
    byTenant.delete(key);
  } else {
    cached = build();
    if (byTenant.size >= MAX_CACHED_TENANTS) {
      byTenant.delete(byTenant.keys().next().value as string);
    }
  }
  byTenant.set(key, cached);
  return cached;
}
