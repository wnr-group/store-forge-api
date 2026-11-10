// GENERATED from wnr-group/store-forge lib/templates/engine/bindings.ts. DO NOT EDIT.

import type { SettingType } from "./descriptors.js";
import { safeUrl } from "./schema.js";

/**
 * Closed allowlist of data binding sources (D9).
 * No expression language or arbitrary code evaluation is permitted.
 */
export const BINDING_SOURCES = [
  "store.name",
  "store.description",
  "product.title",
  "product.description",
  "product.price",
  "product.compare_at_price",
  "product.sku",
  "product.featured_image",
  "collection.title",
  "collection.description",
  "collection.featured_image",
] as const;

export type BindingSource = (typeof BINDING_SOURCES)[number];

export function isBindingSource(value: unknown): value is BindingSource {
  return typeof value === "string" && (BINDING_SOURCES as readonly string[]).includes(value as BindingSource);
}

const COMPATIBILITY_MAP: Record<BindingSource, SettingType[]> = {
  "store.name": ["text"],
  "store.description": ["text", "textarea", "richtext"],
  "product.title": ["text"],
  "product.description": ["text", "textarea", "richtext"],
  "product.price": ["number", "text"],
  "product.compare_at_price": ["number", "text"],
  "product.sku": ["text"],
  "product.featured_image": ["image"],
  "collection.title": ["text"],
  "collection.description": ["text", "textarea", "richtext"],
  "collection.featured_image": ["image"],
};

export function isCompatible(source: string, settingType: SettingType): boolean {
  if (!isBindingSource(source)) return false;
  const allowed = COMPATIBILITY_MAP[source];
  return allowed ? allowed.includes(settingType) : false;
}

export interface BindingContext {
  store?: {
    name?: string;
    description?: string;
  };
  product?: {
    title?: string;
    description?: string;
    price?: number;
    compare_at_price?: number;
    sku?: string;
    featured_image?: { path: string; alt?: string };
  };
  collection?: {
    title?: string;
    description?: string;
    featured_image?: { path: string; alt?: string };
  };
}

/**
 * Resolves a binding against the context, falling back to `binding.fallback`. With `settingType` "url" the
 * result must pass `safeUrl` (the value first, then the fallback), otherwise it is `undefined`: a bound
 * value never reaches a link target unchecked. Other target types are validated by their own schema.
 */
export function resolveBinding(
  binding: { source: string; fallback?: unknown },
  context: BindingContext,
  settingType?: SettingType,
): unknown {
  const resolved = resolveRaw(binding, context);
  if (settingType !== "url") return resolved;
  const safeResolved = typeof resolved === "string" ? safeUrl(resolved) : null;
  if (safeResolved !== null) return safeResolved;
  const fallback = binding?.fallback;
  return typeof fallback === "string" ? (safeUrl(fallback) ?? undefined) : undefined;
}

function resolveRaw(binding: { source: string; fallback?: unknown }, context: BindingContext): unknown {
  if (!binding || typeof binding !== "object") return undefined;
  // Only an allowlisted source is ever looked up (D9): anything else, however it is spelled, is the fallback.
  if (!isBindingSource(binding.source)) return usableOrUndefined(binding.fallback);
  const [scope, field] = binding.source.split(".");
  // No context at all (null, undefined, a non-object) is simply "nothing to look up": the fallback applies.
  const targetScope = context && typeof context === "object" && Object.hasOwn(context, scope)
    ? (context as Record<string, Record<string, unknown> | undefined>)[scope]
    : undefined;
  const value = targetScope && Object.hasOwn(targetScope, field) ? targetScope[field] : undefined;
  return isUsable(value) ? value : usableOrUndefined(binding.fallback);
}

/**
 * A bound value counts only when present: not null or undefined, not an empty or blank string, and never a
 * function, symbol or bigint (none of them is JSON data, so none may leave `resolveBinding`).
 */
function isUsable(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
  return typeof value !== "string" || value.trim() !== "";
}

/** The fallback goes through the same check as a resolved value: an unusable one is no fallback at all. */
function usableOrUndefined(value: unknown): unknown {
  return isUsable(value) ? value : undefined;
}

// The URL allowlist lives in schema.ts; re-exported so binding/richtext callers keep one import site.
export { safeUrl };
