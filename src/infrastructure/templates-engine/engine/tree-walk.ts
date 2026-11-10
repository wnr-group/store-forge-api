// GENERATED from wnr-group/store-forge lib/templates/engine/tree-walk.ts. DO NOT EDIT.

import type { ComponentNode } from "../document.js";
import { LIMITS } from "../limits.js";

/** Own-property test: `in` and plain indexing also match inherited names such as "constructor" or "__proto__". */
export const hasOwn = (obj: object, key: string): boolean => Object.hasOwn(obj, key);

/** The value stored under an own key of `record`, or undefined: never a member inherited from Object.prototype. */
export function lookupOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Every own key of `record` once, in the order the (untrusted) order list gives, then any key the list left out.
 * A node missing from the order list, or hidden behind a prototype name in it, is still validated and
 * scanned; the order check reports the mismatch separately.
 */
export function walkKeys(order: readonly string[], record: Record<string, ComponentNode>): string[] {
  const listed = new Set<string>();
  const keys: string[] = [];
  for (const key of order) {
    // A key listed twice is visited once: walking it again would report a phantom DUPLICATE_ID and double-count it.
    if (!hasOwn(record, key) || listed.has(key)) continue;
    listed.add(key);
    keys.push(key);
  }
  for (const key of Object.keys(record)) {
    if (!listed.has(key)) keys.push(key);
  }
  return keys;
}

/** A JSON object (not null, not an array). */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ShapeProblem {
  path: string;
  message: string;
}

/**
 * Shallow structural check of ONE component node, the same rules as `componentNodeSchema` but without
 * descending into `blocks` (the tree walk visits each child itself). The schema parse cannot be trusted to have
 * seen every node: Zod's `z.record` silently drops an own `__proto__` key (which `JSON.parse` creates), so a
 * node stored under that id reaches the walk unparsed. Running this on every visited node keeps the walk from
 * ever reading a field of a null, a number or a malformed object.
 */
export function nodeShapeProblems(node: unknown, path: string): ShapeProblem[] {
  if (!isPlainRecord(node)) return [{ path, message: "Component must be an object" }];
  const problems: ShapeProblem[] = [];
  if (typeof node.type !== "string" || node.type.length === 0) {
    problems.push({ path: `${path}.type`, message: "Component type is required" });
  }
  if (!isPlainRecord(node.settings)) problems.push({ path: `${path}.settings`, message: "Settings must be an object" });
  if (!isPlainRecord(node.blocks)) problems.push({ path: `${path}.blocks`, message: "Blocks must be an object" });
  if (!Array.isArray(node.block_order) || !node.block_order.every((id) => typeof id === "string")) {
    problems.push({ path: `${path}.block_order`, message: "block_order must be a list of block ids" });
  }
  if (node.disabled !== undefined && typeof node.disabled !== "boolean") {
    problems.push({ path: `${path}.disabled`, message: "disabled must be true or false" });
  }
  return problems;
}

/**
 * Paths of every own `__proto__` key found as an id in a `sections` map or in any `blocks` map (an own `__proto__`
 * is never a legitimate component id: `map[id] = node` would swap the prototype and `Object.assign` or Zod's
 * z.record drop the key). Iterative, so it is safe on any depth; run it after `precheckTreeLimits`, which bounds the
 * tree. Does not descend into a `__proto__` node's own settings, only into its `blocks` (ids below it are reported too).
 */
export function protoIdPaths(input: unknown): string[] {
  if (!isPlainRecord(input) || !isPlainRecord(input.sections)) return [];
  const found: string[] = [];
  const stack: { map: Record<string, unknown>; path: string }[] = [{ map: input.sections, path: "sections" }];
  while (stack.length > 0) {
    const { map, path } = stack.pop() as { map: Record<string, unknown>; path: string };
    for (const [id, node] of Object.entries(map)) {
      const nodePath = `${path}.${id}`;
      if (id === "__proto__") found.push(nodePath);
      if (isPlainRecord(node) && isPlainRecord(node.blocks)) stack.push({ map: node.blocks, path: `${nodePath}.blocks` });
    }
  }
  return found;
}

export interface LimitViolation {
  path: string;
  code: "DEPTH_EXCEEDED" | "LIMIT_EXCEEDED";
  message: string;
}

const isRecord = isPlainRecord;

interface Frame {
  node: unknown;
  /** Block depth under the section (a section's direct blocks are depth 1). */
  depth: number;
  /** Path of the node, built lazily from `parent` so a deep chain costs nothing until a violation is found. */
  parent: Frame | null;
  key: string;
}

function pathOf(frame: Frame): string {
  const parts: string[] = [];
  for (let f: Frame | null = frame; f; f = f.parent) parts.push(f.key);
  return parts.reverse().join(".");
}

/**
 * Iterative, bounded pre-check of the section tree, run BEFORE the recursive schema parse so adversarial
 * input (a chain thousands of blocks deep, a cycle, an enormous fan-out) can never overflow the call stack.
 * Stops at the first block deeper than LIMITS.maxBlockDepth, or as soon as more than
 * LIMITS.maxComponentsPerTemplate nodes were visited, so the work is bounded by that limit whatever the
 * input looks like. Anything that is not a plain object is skipped here; the schema parse reports it.
 */
export function precheckTreeLimits(input: unknown): LimitViolation | null {
  if (!isRecord(input) || !isRecord(input.sections)) return null;

  const tooMany: LimitViolation = {
    path: "",
    code: "LIMIT_EXCEEDED",
    message: `Total components in template exceeds maximum limit of ${LIMITS.maxComponentsPerTemplate}`,
  };
  const sectionsFrame: Frame = { node: null, depth: -1, parent: null, key: "sections" };
  const stack: Frame[] = [];
  const sectionEntries = Object.entries(input.sections);
  if (sectionEntries.length > LIMITS.maxComponentsPerTemplate) return tooMany;
  for (const [id, section] of sectionEntries) {
    stack.push({ node: section, depth: 0, parent: sectionsFrame, key: id });
  }

  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    visited++;
    if (visited > LIMITS.maxComponentsPerTemplate) return tooMany;
    if (frame.depth > LIMITS.maxBlockDepth) {
      return {
        path: pathOf(frame),
        code: "DEPTH_EXCEEDED",
        message: `Block nesting depth exceeds maximum depth of ${LIMITS.maxBlockDepth}`,
      };
    }
    const children = isRecord(frame.node) ? (frame.node as Partial<ComponentNode>).blocks : undefined;
    if (!isRecord(children)) continue;
    const childEntries = Object.entries(children);
    // Everything queued plus everything still to come already exceeds the limit: no need to enqueue more.
    if (visited + stack.length + childEntries.length > LIMITS.maxComponentsPerTemplate) return tooMany;
    const blocksFrame: Frame = { node: null, depth: frame.depth, parent: frame, key: "blocks" };
    for (const [id, child] of childEntries) {
      stack.push({ node: child, depth: frame.depth + 1, parent: blocksFrame, key: id });
    }
  }
  return null;
}
