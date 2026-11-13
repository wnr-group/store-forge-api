// GENERATED from wnr-group/store-forge lib/templates/engine/descriptors.ts. DO NOT EDIT.

/**
 * Single source of truth for template engine settings and component definitions (D5).
 * Plain serializable descriptors drive editor UI controls, validation schemas and default generation.
 */
import type { FontKey } from "./fonts.js";

// Frozen as well as `as const`: the closed type enum (D5) cannot be extended or edited at runtime.
export const SETTING_TYPES = Object.freeze([
  "text",
  "textarea",
  "richtext",
  "number",
  "range",
  "toggle",
  "select",
  "radio",
  "segmented",
  "color",
  "image",
  "url",
  "spacing",
  "typography",
  "border",
  "dataBinding",
] as const);

export type SettingType = (typeof SETTING_TYPES)[number];

export function isSettingType(value: unknown): value is SettingType {
  return typeof value === "string" && (SETTING_TYPES as readonly string[]).includes(value);
}

export type ResponsiveValue<T> =
  | T
  | {
      base: T;
      tablet?: T;
      mobile?: T;
    };

export type VisibilityCondition = {
  setting: string;
  eq?: unknown;
  neq?: unknown;
  in?: unknown[];
};

export type SettingOption = {
  label: string;
  value: string | number;
};

export type ImageValue = {
  path: string;
  alt?: string;
  focal?: { x: number; y: number };
};

export type SpacingValue = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  unit?: "px" | "rem" | "%";
};

export type TypographyValue = {
  /** A closed font key (D21), never free text. */
  fontFamily?: FontKey;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
};

export type BorderValue = {
  width?: number;
  style?: "none" | "solid" | "dashed" | "dotted";
  color?: string;
  radius?: number;
};

export type DataBindingValue = {
  source: string;
  fallback?: unknown;
};

/**
 * Validation messages a descriptor supplies (AC-ENG-004), so the editor and the validator report the
 * merchant-facing wording the component author chose. `min` and `max` belong to the descriptor's own
 * min/max (length for text, value for number and range); `invalid` is the wrong-type or wrong-shape message.
 * Anything not given keeps the engine's default message.
 */
export interface SettingMessages {
  min?: string;
  max?: string;
  invalid?: string;
}

export interface SettingDescriptor {
  /**
   * The key of the setting in a document and in the compiled schema. Rule (an engine rule, not part of D5):
   * `^[A-Za-z][A-Za-z0-9_]*$`, unique within the list, and never a name from Object.prototype ("constructor",
   * "toString", ...) and never "path" (a settings object with a text `path` reads as an image value and is
   * rejected, so a document using such a setting could never validate). `checkDescriptors` reports a violation, `assertValidDescriptors` throws on it, and so does
   * `compileSettings`.
   */
  id: string;
  type: SettingType;
  label: string;
  default: unknown;
  help?: string;
  group?: string;
  responsive?: boolean;
  /**
   * Editor visibility only. A hidden setting (condition false) is still validated and still has its default:
   * `visibleIf` never switches validation off. `isSettingVisible` looks at the one referenced setting's value
   * and is not transitive: a setting whose condition holds is visible even when the setting it refers to is
   * itself hidden. `checkDescriptors` rejects a condition that names an unknown setting, itself or a cycle.
   */
  visibleIf?: VisibilityCondition;
  messages?: SettingMessages;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  allowedSources?: string[];
  allowedProtocols?: string[];
}

export interface BlockDefinition {
  type: string;
  name: string;
  description?: string;
  accepts?: string[];
  maxChildren?: number;
  settings: SettingDescriptor[];
  presets?: {
    name: string;
    settings?: Record<string, unknown>;
  }[];
}

export interface SectionDefinition {
  type: string;
  name: string;
  description?: string;
  category?: string;
  accepts?: string[];
  maxChildren?: number;
  settings: SettingDescriptor[];
  defaultBlocks?: {
    type: string;
    settings?: Record<string, unknown>;
  }[];
  presets?: {
    name: string;
    settings?: Record<string, unknown>;
    blocks?: {
      type: string;
      settings?: Record<string, unknown>;
    }[];
  }[];
}

export interface ComponentRegistry {
  sections: Record<string, SectionDefinition>;
  blocks: Record<string, BlockDefinition>;
}
