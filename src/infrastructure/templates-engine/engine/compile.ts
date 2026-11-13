// GENERATED from wnr-group/store-forge lib/templates/engine/compile.ts. DO NOT EDIT.

import { z } from "zod";
import { LIMITS } from "../limits.js";
import { BINDING_SOURCES, isCompatible, type BindingSource } from "./bindings.js";
import { checkDescriptors } from "./descriptor-check.js";
import { SETTING_TYPES, type SettingDescriptor } from "./descriptors.js";
import { FONT_KEYS, FONT_TRANSFORMS, isValidWeight, TYPOGRAPHY_BOUNDS } from "./fonts.js";
import { hexColorSchema, imageValueSchema, safeUrlSchema } from "./schema.js";

// The compound value schemas are strict: an unknown key is an error, so a responsive wrapper
// (`{base, tablet, mobile}`) is never mistaken for a plain value of a non-responsive setting (AC-ENG-003).
export const spacingSchema = z
  .object({
    top: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional(),
    right: z.number().optional(),
    unit: z.enum(["px", "rem", "%"]).optional(),
  })
  .strict();

/** Closed font enum and bounds from fonts.ts (D21); a weight must be one the chosen family provides. */
export const typographySchema = z
  .object({
    fontFamily: z.enum(FONT_KEYS).optional(),
    fontSize: z.number().min(TYPOGRAPHY_BOUNDS.minSize).max(TYPOGRAPHY_BOUNDS.maxSize).optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    lineHeight: z.number().min(TYPOGRAPHY_BOUNDS.minLineHeight).max(TYPOGRAPHY_BOUNDS.maxLineHeight).optional(),
    letterSpacing: z.number().min(TYPOGRAPHY_BOUNDS.minLetterSpacing).max(TYPOGRAPHY_BOUNDS.maxLetterSpacing).optional(),
    textTransform: z.enum(FONT_TRANSFORMS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fontFamily !== undefined && value.fontWeight !== undefined && !isValidWeight(value.fontFamily, value.fontWeight)) {
      ctx.addIssue({ code: "custom", path: ["fontWeight"], message: `${value.fontFamily} does not provide weight ${value.fontWeight}` });
    }
  });

export const borderSchema = z
  .object({
    width: z.number().min(0).max(50).optional(),
    style: z.enum(["none", "solid", "dashed", "dotted"]).optional(),
    color: hexColorSchema.optional(),
    radius: z.number().min(0).max(100).optional(),
  })
  .strict();

/** The shape of a binding value only; `dataBindingSchemaFor` adds the source allowlist and the fallback rules. */
export const dataBindingSchema = z
  .object({
    source: z.string().min(1),
    fallback: z.unknown().optional(),
  })
  .strict();

/** A schema for the setting types a binding source may feed (the D9 matrix), so a fallback is checked as the target is. */
function fallbackSchemaFor(source: BindingSource, tenantId: string | undefined): z.ZodTypeAny {
  const schemas = SETTING_TYPES.filter((type) => isCompatible(source, type)).map((type) =>
    createBaseSchema({ id: "fallback", type, label: "fallback", default: null }, tenantId),
  );
  return schemas.length === 1 ? schemas[0] : z.union([schemas[0], schemas[1], ...schemas.slice(2)]);
}

/**
 * A dataBinding value: a source from the closed D9 list (narrowed, never widened, by `allowedSources`) and an
 * optional fallback that must be a valid value for what the source feeds. No expression is ever evaluated.
 */
function dataBindingSchemaFor(d: SettingDescriptor, tenantId: string | undefined): z.ZodTypeAny {
  // The tenant is fixed for this compile, so each source's fallback schema is built once, on first use.
  const fallbackSchemas = new Map<string, z.ZodTypeAny>();
  const fallbackSchema = (source: BindingSource): z.ZodTypeAny => {
    let schema = fallbackSchemas.get(source);
    if (schema === undefined) {
      schema = fallbackSchemaFor(source, tenantId);
      fallbackSchemas.set(source, schema);
    }
    return schema;
  };
  return dataBindingSchema.superRefine((value, ctx) => {
    const source = value.source;
    const known = (BINDING_SOURCES as readonly string[]).includes(source);
    if (!known || (d.allowedSources !== undefined && !d.allowedSources.includes(source))) {
      ctx.addIssue({ code: "custom", path: ["source"], message: `Unknown or disallowed data source: ${JSON.stringify(source)}` });
      return;
    }
    if (value.fallback === undefined || value.fallback === null) return;
    const result = fallbackSchema(source as BindingSource).safeParse(value.fallback);
    if (result.success) return;
    for (const issue of result.error.issues) {
      const params = issue.code === "custom" ? issue.params : undefined;
      ctx.addIssue({ code: "custom", path: ["fallback", ...issue.path], message: issue.message, ...(params ? { params } : {}) });
    }
  });
}

function createBaseSchema(d: SettingDescriptor, tenantId?: string): z.ZodTypeAny {
  const msg = d.messages;
  const invalid = msg?.invalid !== undefined ? { error: msg.invalid } : undefined;
  switch (d.type) {
    case "text":
    case "textarea": {
      let s = z.string(invalid).max(LIMITS.maxTextLength, `Must be at most ${LIMITS.maxTextLength} characters`);
      if (d.min !== undefined) s = s.min(d.min, msg?.min);
      if (d.max !== undefined) s = s.max(d.max, msg?.max);
      return s;
    }
    case "richtext": {
      let s = z.string(invalid).max(LIMITS.maxRichtextLength, `Must be at most ${LIMITS.maxRichtextLength} characters`);
      if (d.max !== undefined) s = s.max(d.max, msg?.max);
      return s;
    }
    case "number":
    case "range": {
      let n = z.number(invalid);
      if (d.min !== undefined) n = n.min(d.min, msg?.min);
      if (d.max !== undefined) n = n.max(d.max, msg?.max);
      return n;
    }
    case "toggle": {
      return z.boolean(invalid);
    }
    case "select":
    case "radio":
    case "segmented": {
      if (d.options && d.options.length > 0) {
        const literals = d.options.map((opt) => z.literal(opt.value));
        if (literals.length === 1) return z.literal(d.options[0].value, invalid);
        return z.union([literals[0], literals[1], ...literals.slice(2)], invalid);
      }
      return z.union([z.string(), z.number()], invalid);
    }
    case "color": {
      if (msg?.invalid === undefined) return hexColorSchema;
      // The colour rule stays in hexColorSchema; a descriptor message only replaces the wording of its failures.
      const message = msg.invalid;
      return z.string({ error: message }).refine((value) => hexColorSchema.safeParse(value).success, { error: message });
    }
    case "url": {
      return safeUrlSchema;
    }
    case "image": {
      // The tenant decides where the path may point; without a safe one every image is rejected.
      return imageValueSchema(tenantId).nullable();
    }
    case "spacing": {
      return spacingSchema;
    }
    case "typography": {
      return typographySchema;
    }
    case "border": {
      return borderSchema;
    }
    case "dataBinding": {
      return dataBindingSchemaFor(d, tenantId);
    }
    default: {
      // The type enum is closed (D5): an unknown type is a bad definition, never "accept anything".
      throw new Error(`Unsupported setting type ${JSON.stringify((d as { type: unknown }).type)} for setting "${String(d.id)}"`);
    }
  }
}

export function compileSettingSchema(d: SettingDescriptor, tenantId?: string): z.ZodTypeAny {
  const base = createBaseSchema(d, tenantId);
  if (!d.responsive) {
    return base.optional();
  }

  // Strict: only the three breakpoints exist, and `base` is required (AC-ENG-003).
  const responsiveObj = z
    .object({
      base: base,
      tablet: base.optional(),
      mobile: base.optional(),
    })
    .strict();

  return z.union([base, responsiveObj]).optional();
}

export interface CompiledSettings {
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  defaults: Record<string, unknown>;
  metadata: Record<string, SettingDescriptor>;
}

export interface CompileOptions {
  /** The tenant that owns the document; image paths are checked against it (see imageValueSchema). */
  tenantId?: string;
}

/**
 * Compiles one descriptor list into the Zod schema, the defaults and the control metadata (AC-ENG-001).
 * Throws one aggregated error on a malformed list: structure (bad or duplicate id, type outside the closed enum)
 * and the visibility graph (unknown or self-referencing visibleIf target, cycle), i.e. the full `checkDescriptors`
 * (AC-ENG-004). `compileSettingSchema` stays structural on purpose: it takes ONE descriptor, which has no list for
 * a visibleIf to point into. `defaults` are fresh copies on every call, so a caller may edit them freely.
 */
export function compileSettings(descriptors: SettingDescriptor[], options: CompileOptions = {}): CompiledSettings {
  const problems = checkDescriptors(descriptors);
  if (problems.length > 0) throw new Error(`Invalid settings: ${problems.join("; ")}`);

  const shape: Record<string, z.ZodTypeAny> = {};
  const defaults: Record<string, unknown> = {};
  const metadata: Record<string, SettingDescriptor> = {};

  for (const d of descriptors) {
    shape[d.id] = compileSettingSchema(d, options.tenantId);
    defaults[d.id] = structuredClone(d.default);
    metadata[d.id] = d;
  }

  return {
    schema: z.object(shape),
    defaults,
    metadata,
  };
}
