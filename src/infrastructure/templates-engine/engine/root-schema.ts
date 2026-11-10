// GENERATED from wnr-group/store-forge lib/templates/engine/root-schema.ts. DO NOT EDIT.

import { z } from "zod";
import { DOCUMENT_SCHEMA_VERSION, type TemplateKind } from "../document.js";
import { THEME_GROUPS, isThemeGroup, themeSettingDescriptors } from "../registry/theme-settings.js";
import { compileSettings } from "./compile.js";
import { checkDescriptorStructure } from "./descriptor-check.js";
import type { SettingDescriptor } from "./descriptors.js";
import { isFontKey, isValidWeight, type FontKey } from "./fonts.js";
import { componentNodeSchema, groupTemplateSchema, pageTemplateSchema, socialLinksSchema } from "./schema.js";
import { getForTenant } from "./tenant-cache.js";

/** The font a theme uses when `headingFont` / `bodyFont` is absent: the descriptor default, if it is a closed font key. */
function defaultFont(descriptors: SettingDescriptor[], id: string): FontKey | undefined {
  const fallback = descriptors.find((d) => d.group === "typography" && d.id === id)?.default;
  return isFontKey(fallback) ? fallback : undefined;
}

/**
 * One theme group as a strict object of its compiled descriptors: every key optional, any other key rejected. The
 * typography group also carries the cross-field rule: a weight must be one the EFFECTIVE font provides (D21), the
 * chosen font or else the descriptor default.
 */
function groupSchema(group: string, descriptors: SettingDescriptor[], tenantId: string | undefined): z.ZodTypeAny {
  // Social links keep the host-checked rule (one allowed host list per network, the same list the descriptors come from).
  if (group === "social") return socialLinksSchema;
  const schema = compileSettings(
    descriptors.filter((d) => d.group === group),
    { tenantId },
  ).schema.strict();
  if (group !== "typography") return schema;
  return schema.superRefine((typography, ctx) => {
    for (const [font, weight] of [
      ["headingFont", "headingWeight"],
      ["bodyFont", "bodyWeight"],
    ] as const) {
      const chosen = typography[font];
      const key = isFontKey(chosen) ? chosen : defaultFont(descriptors, font);
      const value = typography[weight];
      if (key !== undefined && typeof value === "number" && !isValidWeight(key, value)) {
        ctx.addIssue({ code: "custom", path: [weight], message: `${key} does not provide weight ${value}` });
      }
    }
  });
}

/**
 * The theme document schema, GENERATED from the descriptor list (AC-ENG-001): `settings[group][id]`, one strict object
 * per group that has descriptors, all keys optional, unknown groups and keys rejected. The tenant reaches the image
 * descriptors (favicon) exactly as it does for sections. `descriptors` is injectable so a test can use a cloned list;
 * the app only ever uses `themeSettingDescriptors`.
 */
export function buildThemeSettingsSchema(descriptors: SettingDescriptor[] = themeSettingDescriptors, tenantId?: string): z.ZodTypeAny {
  const problems = checkDescriptorStructure(descriptors);
  if (problems.length > 0) throw new Error(`Invalid theme settings: ${problems.join("; ")}`);
  for (const d of descriptors) {
    if (!isThemeGroup(d.group)) throw new Error(`Theme setting "${d.id}" is not in a known group`);
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const group of THEME_GROUPS) {
    if (descriptors.some((d) => d.group === group)) shape[group] = groupSchema(group, descriptors, tenantId).optional();
  }
  return z.object({
    schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
    settings: z.object(shape).strict().optional(),
    sections: z.record(z.string(), componentNodeSchema).optional(),
    order: z.array(z.string()).optional(),
  });
}

const themeSchemaCache = new Map<string, z.ZodTypeAny>();

/** The theme schema for one tenant, compiled once and kept in the per-tenant LRU (like section schemas). */
function themeSchemaFor(tenantId: string | undefined): z.ZodTypeAny {
  return getForTenant(themeSchemaCache, tenantId, () => buildThemeSettingsSchema(themeSettingDescriptors, tenantId));
}

/** The theme schema with no tenant: every image value (the favicon) is rejected with TENANT_REQUIRED. */
export const themeSettingsSchema = buildThemeSettingsSchema();

/**
 * The root schema of a document kind; throws for anything that is not one of the seven kinds (validateDocument checks
 * first and reports it). Only the theme schema depends on the tenant (its favicon is an image).
 */
export function getRootSchema(kind: TemplateKind, tenantId?: string): z.ZodTypeAny {
  switch (kind) {
    case "index":
    case "product":
    case "collection":
      return pageTemplateSchema;
    case "group_header":
    case "group_footer":
    case "group_announcement":
      return groupTemplateSchema;
    case "theme_settings":
      return tenantId === undefined ? themeSettingsSchema : themeSchemaFor(tenantId);
    default:
      throw new Error(`Unknown template kind: ${typeof kind === "string" ? JSON.stringify(kind) : typeof kind}`);
  }
}
