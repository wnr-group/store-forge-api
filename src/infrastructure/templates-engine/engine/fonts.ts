// GENERATED from wnr-group/store-forge lib/templates/engine/fonts.ts. DO NOT EDIT.

/**
 * Closed font registry and typography boundaries (D21).
 * Supports exactly 5 approved font keys. No external Google Fonts requests.
 */

export const FONT_KEYS = [
  "inter",
  "manrope",
  "system-sans",
  "system-serif",
  "system-mono",
] as const;

export type FontKey = (typeof FONT_KEYS)[number];

export function isFontKey(value: unknown): value is FontKey {
  return typeof value === "string" && (FONT_KEYS as readonly string[]).includes(value);
}

export const FONT_TRANSFORMS = ["none", "uppercase", "lowercase", "capitalize"] as const;
export type FontTransform = (typeof FONT_TRANSFORMS)[number];

export function isFontTransform(value: unknown): value is FontTransform {
  return typeof value === "string" && (FONT_TRANSFORMS as readonly string[]).includes(value);
}

export interface FontConfig {
  key: FontKey;
  name: string;
  fontFamily: string;
  variable: boolean;
  minWeight?: number;
  maxWeight?: number;
  weights?: number[];
  woff2Path?: string;
}

export const FONT_REGISTRY: Record<FontKey, FontConfig> = {
  inter: {
    key: "inter",
    name: "Inter",
    fontFamily: "var(--font-inter), sans-serif",
    variable: true,
    minWeight: 100,
    maxWeight: 900,
    woff2Path: "app/fonts/inter-latin.woff2",
  },
  manrope: {
    key: "manrope",
    name: "Manrope",
    fontFamily: "var(--font-manrope), sans-serif",
    variable: true,
    minWeight: 200,
    maxWeight: 800,
    woff2Path: "app/fonts/manrope-latin.woff2",
  },
  "system-sans": {
    key: "system-sans",
    name: "System Sans",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    variable: false,
    minWeight: 100,
    maxWeight: 900,
  },
  "system-serif": {
    key: "system-serif",
    name: "System Serif",
    fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
    variable: false,
    weights: [400, 700],
  },
  "system-mono": {
    key: "system-mono",
    name: "System Mono",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    variable: false,
    weights: [400, 700],
  },
};

export const TYPOGRAPHY_BOUNDS = {
  minSize: 10,
  maxSize: 96,
  minLineHeight: 0.8,
  maxLineHeight: 2.5,
  minLetterSpacing: -2,
  maxLetterSpacing: 10,
} as const;

/** A weight is a whole number the font provides: inside the variable range, or on the fixed list. */
export function isValidWeight(fontKey: FontKey, weight: number): boolean {
  if (!isFontKey(fontKey) || !Number.isInteger(weight)) return false;
  const font = FONT_REGISTRY[fontKey];
  if (font.variable && font.minWeight !== undefined && font.maxWeight !== undefined) {
    return weight >= font.minWeight && weight <= font.maxWeight;
  }
  if (font.weights) {
    return font.weights.includes(weight);
  }
  if (font.minWeight !== undefined && font.maxWeight !== undefined) {
    return weight >= font.minWeight && weight <= font.maxWeight;
  }
  return false;
}
