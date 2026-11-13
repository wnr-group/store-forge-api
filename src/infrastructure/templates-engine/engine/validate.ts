// GENERATED from wnr-group/store-forge lib/templates/engine/validate.ts. DO NOT EDIT.

import type { z } from "zod";
import { TEMPLATE_KINDS, type ComponentNode, type TemplateDocument, type TemplateKind } from "../document.js";
import { LIMITS } from "../limits.js";
import { compileSettings } from "./compile.js";
import type { BlockDefinition, ComponentRegistry, SectionDefinition } from "./descriptors.js";
import { checkImageShape, scanImageValues } from "./image-scan.js";
import { getRootSchema } from "./root-schema.js";
import { imageIssueCode, isSafeTenantId } from "./schema.js";
import { getForTenant } from "./tenant-cache.js";
import { isDepthFailure, measureDocument, measureFailureIssue } from "./measure.js";
import { hasOwn, lookupOwn, nodeShapeProblems, precheckTreeLimits, protoIdPaths, walkKeys } from "./tree-walk.js";

type SettingsSchema = z.ZodObject<Record<string, z.ZodTypeAny>>;

/**
 * Compiled settings schemas, per definition object and per tenant. The tenant is part of the compiled
 * schema (it decides which image paths pass), so a schema built for one tenant is never reused for
 * another tenant or for "no tenant": the inner map is a small per-tenant LRU (see tenant-cache.ts) so many
 * tenants cannot grow it unbounded.
 */
const compiledSchemaCache = new WeakMap<SectionDefinition | BlockDefinition, Map<string, SettingsSchema>>();

function getCompiledSchema(def: SectionDefinition | BlockDefinition, tenantId: string | undefined): SettingsSchema {
  let byTenant = compiledSchemaCache.get(def);
  if (!byTenant) {
    byTenant = new Map();
    compiledSchemaCache.set(def, byTenant);
  }
  return getForTenant(byTenant, tenantId, () => compileSettings(def.settings, { tenantId }).schema);
}

/** Error names the INTERNAL_ERROR message may repeat: a plain identifier, nothing else. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

const utf8Encoder = new TextEncoder();

/** UTF-8 byte size of a string, same as Node's Buffer.byteLength(str, "utf8") but usable in the browser. */
export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

export interface Issue {
  path: string;
  code: string;
  message: string;
  level: "error" | "warning";
}

export type ValidationResult =
  | {
      ok: true;
      document: TemplateDocument;
      issues: Issue[];
    }
  | {
      ok: false;
      issues: Issue[];
    };

export interface ValidationContext {
  tenantId?: string;
}

/**
 * Validates `input` as a document of `kind`. Never throws, whatever the input (any JSON.parse output, a
 * non-string kind): every problem comes back as an error issue. The body below is written not to throw; the
 * catch is a last line of defence that reports INTERNAL_ERROR instead of letting a bug escape.
 */
export function validateDocument(
  kind: TemplateKind,
  input: unknown,
  registry: ComponentRegistry,
  context?: ValidationContext,
): ValidationResult {
  if (typeof kind !== "string" || !(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
    const shown = typeof kind === "string" ? JSON.stringify(kind) : typeof kind;
    return {
      ok: false,
      issues: [{ path: "", code: "UNKNOWN_KIND", message: `Unknown template kind: ${shown}`, level: "error" }],
    };
  }
  try {
    return validateKnownKind(kind, input, registry, context);
  } catch (error) {
    // The error NAME helps to find the bug; the message is left out because it may quote document text. The
    // name is only echoed when it is a plain identifier (it is not trusted: it could hold anything).
    const name = error instanceof Error && typeof error.name === "string" && SAFE_ERROR_NAME.test(error.name) ? `: ${error.name}` : "";
    return {
      ok: false,
      issues: [
        { path: "", code: "INTERNAL_ERROR", message: `The document could not be validated (internal error${name})`, level: "error" },
      ],
    };
  }
}

function validateKnownKind(
  kind: TemplateKind,
  input: unknown,
  registry: ComponentRegistry,
  context?: ValidationContext,
): ValidationResult {
  const issues: Issue[] = [];
  // A missing or unsafe tenant id is treated as "no tenant": any image value then fails (TENANT_REQUIRED).
  const tenantId = isSafeTenantId(context?.tenantId) ? context.tenantId : undefined;

  // 0. Depth and component-count limits, checked iteratively before the recursive schema parse below, which
  //    would overflow the call stack on a chain thousands of blocks deep.
  const tooBig = precheckTreeLimits(input);
  if (tooBig) return { ok: false, issues: [{ ...tooBig, level: "error" }] };

  // 0b. Measure the document now. The precheck above never descends into settings, but the schema parse and the
  //     scans below would walk values of any depth, and the save path serializes and clones the whole document
  //     recursively: a value nested deeper than LIMITS.maxValueDepth is refused here, before any of them runs.
  //     Other measurement failures (NUL or lone surrogate, cycle) are reported at step 2, after the schema check.
  const measured = measureDocument(input);
  if (isDepthFailure(measured)) {
    return { ok: false, issues: [{ path: "", ...measureFailureIssue(measured.error), level: "error" }] };
  }

  // Image rule issues come from two places that can see the same value (the descriptor schema and the
  // structural scan below); report each (path, code) once.
  const reportedImageIssues = new Set<string>();
  function addImageIssue(path: string, code: string, message: string) {
    const key = `${path}|${code}`;
    if (reportedImageIssues.has(key)) return;
    reportedImageIssues.add(key);
    issues.push({ path, code, message, level: "error" });
  }

  /**
   * An own `__proto__` key (JSON.parse creates one) is never legitimate outside the section and block id maps,
   * which the walk validates node by node: Zod drops it silently, so without this it would be stored unchecked.
   */
  const reportedProtoKeys = new Set<string>();
  function reportProtoKey(path: string, message = "A key named __proto__ is not allowed") {
    if (reportedProtoKeys.has(path)) return;
    reportedProtoKeys.add(path);
    issues.push({ path, code: "SCHEMA_ERROR", message, level: "error" });
  }

  // An own `__proto__` is never a legitimate section or block id, even for a well-formed node: reported at its exact
  // path before anything else, so it also shows when the schema parse fails; the walk and the scans still run.
  for (const path of protoIdPaths(input)) reportProtoKey(path, "Component ids named __proto__ are not allowed");

  /** Scans every own key of `obj` except `skip` for image-shaped values and `__proto__` keys (see scanImageValues). */
  function scanKeysExcept(obj: object, skip: string, basePath: string) {
    if (hasOwn(obj, "__proto__")) reportProtoKey(basePath ? `${basePath}.__proto__` : "__proto__");
    checkImageShape(obj, basePath, tenantId, addImageIssue); // a `path` directly on a section, block or the root
    for (const [key, value] of Object.entries(obj)) {
      if (key === skip) continue;
      scanImageValues(value, basePath ? `${basePath}.${key}` : key, tenantId, addImageIssue, reportProtoKey);
    }
  }

  // 1. Basic structural and root schema check
  //    The theme schema is tenant-aware (its favicon is an image), so an image rule failure keeps its code.
  const rootSchema = getRootSchema(kind, tenantId);
  const parsed = rootSchema.safeParse(input);
  if (!parsed.success) {
    for (const err of parsed.error.issues) {
      const basePath = err.path.map(String);
      if (err.code === "unrecognized_keys") {
        // One issue per unknown key, at the key's own path (a hostile key name is never echoed in the message).
        for (const key of err.keys) {
          const path = [...basePath, key].join(".");
          if (key === "__proto__") reportProtoKey(path);
          else issues.push({ path, code: "SCHEMA_ERROR", message: "This key is not a known setting", level: "error" });
        }
        continue;
      }
      const imageCode = imageIssueCode(err);
      if (imageCode) {
        addImageIssue(basePath.join("."), imageCode, err.message);
      } else {
        issues.push({ path: basePath.join("."), code: "SCHEMA_ERROR", message: err.message, level: "error" });
      }
    }
    // A theme document that fails still gets the structural scan: it names image and `__proto__` problems anywhere
    // in `settings`, including under keys the schema rejects as unknown, instead of leaving them unreported.
    // (Not when the measurement failed: a cycle must never reach a recursive walk.)
    if (kind === "theme_settings" && !("error" in measured) && typeof input === "object" && input !== null && !Array.isArray(input)) {
      scanKeysExcept(input, "sections", "");
    }
    return { ok: false, issues };
  }

  const doc = input as TemplateDocument;

  // 2. Byte limit check (256 KB), measured the way the database CHECK measures it: the UTF-8 length of the
  //    jsonb text form (see size.ts), which is longer than the compact JSON.
  let byteLength = 0;
  if ("error" in measured) {
    const failure = measureFailureIssue(measured.error);
    issues.push({ path: "", ...failure, level: "error" });
    // Text the database cannot store is reported, and the walk below still runs: it can name more problems
    // (an image path containing a NUL is also a CROSS_TENANT_PATH). The size is unknown then, so it is not checked.
    if (failure.code !== "UNSUPPORTED_TEXT") return { ok: false, issues };
  } else {
    byteLength = measured.bytes;
  }

  if (byteLength > LIMITS.maxDocumentBytes) {
    issues.push({
      path: "",
      code: "DOCUMENT_SIZE_EXCEEDED",
      message: `Document size (${byteLength} bytes) exceeds limit of ${LIMITS.maxDocumentBytes} bytes`,
      level: "error",
    });
    // Nothing else is worth walking or scanning for a document that can never be stored.
    return { ok: false, issues };
  }

  // 3. Tree validation
  const seenIds = new Set<string>();
  let totalComponents = 0;

  /** Validates a registered component's settings against its compiled descriptors (tenant-aware). */
  function checkSettings(def: SectionDefinition | BlockDefinition, settings: ComponentNode["settings"], nodePath: string) {
    const res = getCompiledSchema(def, tenantId).safeParse(settings || {});
    if (res.success) return;
    for (const err of res.error.issues) {
      const path = `${nodePath}.settings.${err.path.join(".")}`;
      const imageCode = imageIssueCode(err);
      if (imageCode) {
        addImageIssue(path, imageCode, err.message);
      } else {
        issues.push({ path, code: "INVALID_SETTING", message: err.message, level: "error" });
      }
    }
  }

  /**
   * Reports a node that is not a well-formed component (see nodeShapeProblems) and tells the walk to skip it.
   * The schema parse already vetted every node it could see; this covers the ones hidden under an own `__proto__` id.
   */
  function isMalformedNode(node: unknown, nodePath: string): boolean {
    const problems = nodeShapeProblems(node, nodePath);
    for (const problem of problems) {
      issues.push({ path: problem.path, code: "SCHEMA_ERROR", message: problem.message, level: "error" });
    }
    return problems.length > 0;
  }

  /**
   * Every section and block, registered or not, at every depth: every node key except `blocks` (which the
   * tree walk visits node by node), so settings, extra keys and an image-shaped `settings` object itself
   * are all checked. Registered components are also covered by their descriptors; unknown types by this alone.
   */
  function scanNode(node: ComponentNode, nodePath: string) {
    scanKeysExcept(node, "blocks", nodePath);
  }

  // Everything at the document root except the section tree (the walk below scans each node): theme
  // settings, a theme root `layout` and any unknown root key.
  scanKeysExcept(doc, "sections", "");

  const sections = doc.sections || {};
  const sectionKeys = Object.keys(sections);
  const sectionOrder = doc.order || [];

  // Sections count limit
  if (sectionKeys.length > LIMITS.maxSectionsPerTemplate) {
    issues.push({
      path: "sections",
      code: "LIMIT_EXCEEDED",
      message: `Sections count (${sectionKeys.length}) exceeds maximum limit of ${LIMITS.maxSectionsPerTemplate} sections`,
      level: "error",
    });
  }

  // Order matching
  if (
    sectionOrder.length !== sectionKeys.length ||
    new Set(sectionOrder).size !== sectionOrder.length ||
    !sectionOrder.every((k: string) => hasOwn(sections, k))
  ) {
    issues.push({
      path: "order",
      code: "ORDER_MISMATCH",
      message: "Section order must match the exact set of section IDs without duplicates",
      level: "error",
    });
  }

  function validateBlock(
    blockId: string,
    blockNode: ComponentNode,
    currentPath: string,
    depth: number,
    parentAccepts?: string[],
  ): number {
    totalComponents++;

    // Unique ID check
    if (seenIds.has(blockId)) {
      issues.push({
        path: currentPath,
        code: "DUPLICATE_ID",
        message: `Duplicate component ID found: ${blockId}`,
        level: "error",
      });
    }
    seenIds.add(blockId);

    if (isMalformedNode(blockNode, currentPath)) return 1;

    // Depth check (D6: max depth 3)
    if (depth > LIMITS.maxBlockDepth) {
      issues.push({
        path: currentPath,
        code: "DEPTH_EXCEEDED",
        message: `Block nesting depth (${depth}) exceeds maximum depth of ${LIMITS.maxBlockDepth}`,
        level: "error",
      });
    }

    // Acceptance check
    if (parentAccepts && !parentAccepts.includes(blockNode.type)) {
      issues.push({
        path: `${currentPath}.type`,
        code: "INVALID_CHILD_TYPE",
        message: `Parent does not accept child blocks of type '${blockNode.type}'`,
        level: "error",
      });
    }

    // Registry check
    const blockDef = lookupOwn(registry.blocks, blockNode.type);
    if (!blockDef) {
      issues.push({
        path: `${currentPath}.type`,
        code: "UNKNOWN_COMPONENT",
        message: `Unknown block component type: '${blockNode.type}'`,
        level: "warning",
      });
    } else {
      checkSettings(blockDef, blockNode.settings, currentPath);
    }
    scanNode(blockNode, currentPath);

    // Order check for nested blocks
    const childBlocks = blockNode.blocks || {};
    const childKeys = Object.keys(childBlocks);
    const childOrder = blockNode.block_order || [];

    if (
      childOrder.length !== childKeys.length ||
      new Set(childOrder).size !== childOrder.length ||
      !childOrder.every((k: string) => hasOwn(childBlocks, k))
    ) {
      issues.push({
        path: `${currentPath}.block_order`,
        code: "ORDER_MISMATCH",
        message: `block_order must match the exact set of child block keys without duplicates`,
        level: "error",
      });
    }

    // Check maxChildren
    if (blockDef?.maxChildren !== undefined && childKeys.length > blockDef.maxChildren) {
      issues.push({
        path: `${currentPath}.blocks`,
        code: "MAX_CHILDREN_EXCEEDED",
        message: `Block children count (${childKeys.length}) exceeds max of ${blockDef.maxChildren}`,
        level: "error",
      });
    }

    let nestedBlocksCount = 1;
    for (const childId of walkKeys(childOrder, childBlocks)) {
      nestedBlocksCount += validateBlock(
        childId,
        childBlocks[childId],
        `${currentPath}.blocks.${childId}`,
        depth + 1,
        blockDef?.accepts,
      );
    }

    return nestedBlocksCount;
  }

  for (const sectionId of walkKeys(sectionOrder, sections)) {
    const section = sections[sectionId];

    totalComponents++;

    if (seenIds.has(sectionId)) {
      issues.push({
        path: `sections.${sectionId}`,
        code: "DUPLICATE_ID",
        message: `Duplicate component ID found: ${sectionId}`,
        level: "error",
      });
    }
    seenIds.add(sectionId);

    if (isMalformedNode(section, `sections.${sectionId}`)) continue;

    const sectionDef = lookupOwn(registry.sections, section.type);
    if (!sectionDef) {
      issues.push({
        path: `sections.${sectionId}.type`,
        code: "UNKNOWN_COMPONENT",
        message: `Unknown section component type: '${section.type}'`,
        level: "warning",
      });
    } else {
      checkSettings(sectionDef, section.settings, `sections.${sectionId}`);
    }
    scanNode(section, `sections.${sectionId}`);

    const blocks = section.blocks || {};
    const blockKeys = Object.keys(blocks);
    const blockOrder = section.block_order || [];

    if (
      blockOrder.length !== blockKeys.length ||
      new Set(blockOrder).size !== blockOrder.length ||
      !blockOrder.every((k: string) => hasOwn(blocks, k))
    ) {
      issues.push({
        path: `sections.${sectionId}.block_order`,
        code: "ORDER_MISMATCH",
        message: `block_order in section '${sectionId}' must match the exact set of block keys`,
        level: "error",
      });
    }

    if (sectionDef?.maxChildren !== undefined && blockKeys.length > sectionDef.maxChildren) {
      issues.push({
        path: `sections.${sectionId}.blocks`,
        code: "MAX_CHILDREN_EXCEEDED",
        message: `Section children count (${blockKeys.length}) exceeds max of ${sectionDef.maxChildren}`,
        level: "error",
      });
    }

    let sectionBlocksTotal = 0;
    for (const blockId of walkKeys(blockOrder, blocks)) {
      sectionBlocksTotal += validateBlock(
        blockId,
        blocks[blockId],
        `sections.${sectionId}.blocks.${blockId}`,
        1,
        sectionDef?.accepts,
      );
    }

    if (sectionBlocksTotal > LIMITS.maxBlocksPerSection) {
      issues.push({
        path: `sections.${sectionId}.blocks`,
        code: "LIMIT_EXCEEDED",
        message: `Total blocks in section '${sectionId}' (${sectionBlocksTotal}) exceeds maximum limit of ${LIMITS.maxBlocksPerSection}`,
        level: "error",
      });
    }
  }

  if (totalComponents > LIMITS.maxComponentsPerTemplate) {
    issues.push({
      path: "",
      code: "LIMIT_EXCEEDED",
      message: `Total components in template (${totalComponents}) exceeds maximum limit of ${LIMITS.maxComponentsPerTemplate}`,
      level: "error",
    });
  }

  const hasErrors = issues.some((i) => i.level === "error");
  if (hasErrors) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    document: doc,
    issues,
  };
}
