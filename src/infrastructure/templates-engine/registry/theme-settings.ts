// GENERATED from wnr-group/store-forge lib/templates/registry/theme-settings.ts. DO NOT EDIT.

import type { SettingDescriptor } from "../engine/descriptors.js";
import { FONT_KEYS, FONT_REGISTRY, type FontKey } from "../engine/fonts.js";
import { ALLOWED_SOCIAL_NETWORKS } from "../engine/schema.js";

/**
 * The closed list of theme setting groups (D24: Brand, Colours, Typography, Layout, Buttons, Product cards,
 * Product page, Social). A descriptor's `group` is one of these ids and is also the key of its object in the stored
 * document: `settings[group][id]`. `productCards` and `productPage` have no descriptors yet: the product card
 * and product page settings are added by a later phase (Phase 4 and Phase 6 of the template engine plan).
 */
export const THEME_GROUPS = Object.freeze([
  "brand",
  "colors",
  "typography",
  "layout",
  "buttons",
  "productCards",
  "productPage",
  "social",
] as const);
export type ThemeGroup = (typeof THEME_GROUPS)[number];

export function isThemeGroup(value: unknown): value is ThemeGroup {
  return typeof value === "string" && (THEME_GROUPS as readonly string[]).includes(value);
}

/** Select options for a font setting: every registered font, the setting's default font first, labels from the registry. */
function fontOptions(first: FontKey): { label: string; value: string }[] {
  return [first, ...FONT_KEYS.filter((key) => key !== first)].map((key) => ({ label: FONT_REGISTRY[key].name, value: key }));
}

function color(id: string, label: string, def: string): SettingDescriptor {
  return { id, type: "color", label, default: def, group: "colors" };
}

const SOCIAL_LABELS: Record<keyof typeof ALLOWED_SOCIAL_NETWORKS, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  x: "X",
  twitter: "Twitter",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

/** One link per network of the single ALLOWED_SOCIAL_NETWORKS list; a blank default means "no link" (the `url` convention). */
const socialDescriptors: SettingDescriptor[] = (Object.keys(SOCIAL_LABELS) as (keyof typeof SOCIAL_LABELS)[]).map((network) => ({
  id: network,
  type: "url",
  label: `${SOCIAL_LABELS[network]} link`,
  default: "",
  group: "social",
}));

/**
 * The single definition of the theme settings (AC-ENG-001, D5, D24). Ids are the nested keys of the stored document
 * (`settings.colors.primary`, `settings.typography.headingFont`, ...). The generated `themeSettingsSchema`
 * (engine/root-schema.ts), the defaults and the CSS bounds of `themeToCssVars` (engine/theme-css.ts) all read this
 * list, so a bound or default changed here changes validation and CSS together. Every setting is optional in a
 * document; a missing one takes its default here when rendered.
 */
export const themeSettingDescriptors: SettingDescriptor[] = [
  { id: "favicon", type: "image", label: "Favicon", default: null, group: "brand" },
  color("primary", "Primary Color", "#1a5aaa"),
  color("secondary", "Secondary Color", "#64748b"),
  color("background", "Background Color", "#ffffff"),
  color("text", "Text Color", "#0f172a"),
  color("accent", "Accent Color", "#f59e0b"),
  color("muted", "Muted Color", "#94a3b8"),
  color("border", "Border Color", "#e2e8f0"),
  {
    id: "headingFont",
    type: "select",
    label: "Heading Font",
    default: "manrope",
    group: "typography",
    options: fontOptions("manrope"),
  },
  {
    id: "bodyFont",
    type: "select",
    label: "Body Font",
    default: "inter",
    group: "typography",
    options: fontOptions("inter"),
  },
  { id: "baseSize", type: "range", label: "Base Font Size", default: 16, min: 10, max: 40, unit: "px", group: "typography" },
  { id: "headingWeight", type: "number", label: "Heading Weight", default: 700, min: 100, max: 900, group: "typography" },
  { id: "bodyWeight", type: "number", label: "Body Weight", default: 400, min: 100, max: 900, group: "typography" },
  { id: "lineHeight", type: "range", label: "Line Height", default: 1.5, min: 0.8, max: 2.5, step: 0.1, group: "typography" },
  { id: "pageWidth", type: "range", label: "Page Width", default: 1280, min: 800, max: 1920, unit: "px", group: "layout" },
  { id: "gridGap", type: "range", label: "Grid Gap", default: 24, min: 0, max: 100, unit: "px", group: "layout" },
  { id: "radius", type: "range", label: "Button Corner Radius", default: 6, min: 0, max: 50, unit: "px", group: "buttons" },
  ...socialDescriptors,
];
