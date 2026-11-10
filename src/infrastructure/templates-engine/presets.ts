// GENERATED from wnr-group/store-forge lib/templates/presets.ts. DO NOT EDIT.

import type { TemplateDocument, TemplateKind } from "./document.js";

import { classicPreset } from "./registry/presets/classic.js";
import { spotlightPreset } from "./registry/presets/spotlight.js";
import { productPreset } from "./registry/presets/product.js";
import { collectionPreset } from "./registry/presets/collection.js";
import { groupHeaderPreset } from "./registry/presets/group-header.js";
import { groupFooterPreset } from "./registry/presets/group-footer.js";
import { groupAnnouncementPreset } from "./registry/presets/group-announcement.js";
import { themePreset } from "./registry/presets/theme.js";

export {
  classicPreset,
  spotlightPreset,
  productPreset,
  collectionPreset,
  groupHeaderPreset,
  groupFooterPreset,
  groupAnnouncementPreset,
  themePreset,
};

/**
 * Code-defined homepage presets (D17). A preset is read-only; merchants get editable copies.
 * Unset settings are simply absent, which means "use the default" (heading and subheading default to the
 * store's name and description at render time, exactly as the V1 storefront did).
 */
export const INDEX_PRESET_KEYS = ["classic", "spotlight"] as const;
export type IndexPresetKey = (typeof INDEX_PRESET_KEYS)[number];

/** The V1 `store_template_settings` values, camelCase. */
export type LegacyTemplateSettings = {
  templateKey: string;
  accentColor: string | null;
  heroHeading: string | null;
  heroSubheading: string | null;
  heroImagePath: string | null;
};

export function isIndexPresetKey(key: unknown): key is IndexPresetKey {
  return typeof key === "string" && (INDEX_PRESET_KEYS as readonly string[]).includes(key);
}

export function indexPreset(key: IndexPresetKey): TemplateDocument {
  if (key === "spotlight") {
    return spotlightPreset;
  }
  return classicPreset;
}

const clean = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? undefined : t;
};

/**
 * The document the data migration (0013) creates for a store that had V1 settings. Unknown keys render
 * the default, so they map to `classic`, as the V1 resolver did. This must stay equal to the SQL in 0013,
 * which is a frozen version-1 snapshot; tests/db/templates-migration.test.ts compares the two.
 */
export function applyLegacyToPreset(legacy: LegacyTemplateSettings): { name: string; document: TemplateDocument } {
  const key: IndexPresetKey = isIndexPresetKey(legacy.templateKey) ? legacy.templateKey : "classic";
  const base = indexPreset(key);
  const accent = clean(legacy.accentColor);
  const heading = clean(legacy.heroHeading);
  const subheading = clean(legacy.heroSubheading);
  const imagePath = clean(legacy.heroImagePath);
  const hero: Record<string, unknown> = { variant: key };
  if (heading) hero.heading = heading;
  if (subheading) hero.subheading = subheading;
  if (imagePath) hero.image = { path: imagePath, alt: "" };
  if (accent) hero.accentColor = accent;
  const products: Record<string, unknown> = accent ? { accentColor: accent } : {};
  return {
    name: key === "spotlight" ? "Spotlight" : "Classic",
    document: {
      ...base,
      sections: { hero: { ...base.sections.hero, settings: hero }, products: { ...base.sections.products, settings: products } },
    },
  };
}

/**
 * Returns the default preset document for a given template kind (D8, D17).
 */
export function getPresetDocument(kind: TemplateKind, key?: string): TemplateDocument | Record<string, unknown> {
  switch (kind) {
    case "index":
      return key === "spotlight" ? spotlightPreset : classicPreset;
    case "product":
      return productPreset;
    case "collection":
      return collectionPreset;
    case "group_header":
      return groupHeaderPreset;
    case "group_footer":
      return groupFooterPreset;
    case "group_announcement":
      return groupAnnouncementPreset;
    case "theme_settings":
      return themePreset;
    default:
      return classicPreset;
  }
}
