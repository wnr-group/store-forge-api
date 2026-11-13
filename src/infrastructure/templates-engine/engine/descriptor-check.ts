// GENERATED from wnr-group/store-forge lib/templates/engine/descriptor-check.ts. DO NOT EDIT.

/**
 * Definition-time checks for descriptor lists (AC-ENG-001, AC-ENG-002, AC-ENG-004) and the visibility
 * evaluator the editor shares with them. A descriptor list is the single source of truth (D5), so a malformed
 * one is a programming error: these checks report it when the definition is written or compiled, long before
 * a merchant document meets it.
 */
import { BINDING_SOURCES } from "./bindings.js";
import { isSettingType, type SettingDescriptor } from "./descriptors.js";

/** Setting ids become object keys in documents and schemas: plain identifiers, never prototype names. */
const SETTING_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

const MESSAGE_KEYS = ["min", "max", "invalid"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Structure every compiled list must have: an object per entry, a safe unique id and a type from the closed
 * enum. Returns one message per problem; an empty array means the list is well formed.
 */
export function checkDescriptorStructure(descriptors: readonly SettingDescriptor[]): string[] {
  if (!Array.isArray(descriptors)) return ["descriptors must be an array"];
  const problems: string[] = [];
  const seen = new Set<string>();
  descriptors.forEach((d: unknown, index) => {
    if (!isRecord(d)) {
      problems.push(`descriptor #${index} must be an object`);
      return;
    }
    const id = d.id;
    if (typeof id !== "string" || !SETTING_ID.test(id) || id in Object.prototype) {
      problems.push(`descriptor #${index} has an invalid id ${JSON.stringify(id)} (letters, digits and underscores, starting with a letter)`);
    } else if (id === "path") {
      // The settings object would hold a string `path`, which the image rule reads as an image value.
      problems.push(`setting id "path" is reserved: an object with a text "path" is an image value (use another id)`);
    } else if (seen.has(id)) {
      problems.push(`duplicate setting id "${id}"`);
    } else {
      seen.add(id);
    }
    if (!isSettingType(d.type)) {
      problems.push(`setting "${String(id)}" has an unsupported type ${JSON.stringify(d.type)}`);
    }
  });
  return problems;
}

/** Visibility graph: every `visibleIf` names another setting of the list, has an operator, and has no cycle. */
function checkVisibility(descriptors: readonly SettingDescriptor[]): string[] {
  const problems: string[] = [];
  const ids = new Set(descriptors.map((d) => d.id));
  const edges = new Map<string, string>();
  for (const d of descriptors) {
    const cond = d.visibleIf;
    if (cond === undefined) continue;
    if (!isRecord(cond) || typeof cond.setting !== "string") {
      problems.push(`setting "${d.id}" has a visibleIf without a setting`);
      continue;
    }
    if (cond.setting === d.id) {
      problems.push(`setting "${d.id}" has a visibleIf that refers to itself`);
      continue;
    }
    if (!ids.has(cond.setting)) {
      problems.push(`setting "${d.id}" has a visibleIf that refers to unknown setting "${cond.setting}"`);
      continue;
    }
    const hasOperator = Object.hasOwn(cond, "eq") || Object.hasOwn(cond, "neq") || Object.hasOwn(cond, "in");
    if (!hasOperator) problems.push(`setting "${d.id}" has a visibleIf with no operator (eq, neq or in)`);
    if (Object.hasOwn(cond, "in") && !Array.isArray(cond.in)) problems.push(`setting "${d.id}" has a visibleIf "in" that is not an array`);
    edges.set(d.id, cond.setting);
  }
  // Each setting has at most one outgoing edge, so a cycle is found by following the chain from every start.
  const reported = new Set<string>();
  for (const start of edges.keys()) {
    const path = new Set<string>();
    for (let at: string | undefined = start; at !== undefined; at = edges.get(at)) {
      if (path.has(at)) {
        if (!reported.has(at)) problems.push(`visibleIf forms a cycle through "${at}"`);
        for (const member of path) reported.add(member);
        break;
      }
      path.add(at);
    }
  }
  return problems;
}

/** Everything checkDescriptorStructure reports, plus visibility, binding sources, message and range sanity. */
export function checkDescriptors(descriptors: readonly SettingDescriptor[]): string[] {
  const problems = checkDescriptorStructure(descriptors);
  if (problems.length > 0) return problems;
  problems.push(...checkVisibility(descriptors));
  for (const d of descriptors) {
    if (d.allowedSources !== undefined) {
      const bad = d.allowedSources.filter((s) => !(BINDING_SOURCES as readonly string[]).includes(s));
      if (d.type !== "dataBinding") problems.push(`setting "${d.id}" lists allowedSources but is not a dataBinding`);
      if (bad.length > 0) problems.push(`setting "${d.id}" has allowedSources that are not binding sources: ${bad.join(", ")}`);
    }
    if (d.min !== undefined && d.max !== undefined && d.min > d.max) {
      problems.push(`setting "${d.id}" has min above max`);
    }
    if (d.messages !== undefined) {
      const messages = d.messages as unknown;
      const valid =
        isRecord(messages) &&
        Object.entries(messages).every(([key, value]) => (MESSAGE_KEYS as readonly string[]).includes(key) && typeof value === "string");
      if (!valid) problems.push(`setting "${d.id}" has messages that are not strings under min, max or invalid`);
    }
  }
  return problems;
}

/** Throws one error listing every problem of `descriptors`; `name` says which definition it belongs to. */
export function assertValidDescriptors(descriptors: readonly SettingDescriptor[], name: string): void {
  const problems = checkDescriptors(descriptors);
  if (problems.length > 0) throw new Error(`Invalid settings for ${name}: ${problems.join("; ")}`);
}

/**
 * Whether the editor shows `descriptor`, given the effective values of the other settings. A descriptor with no
 * condition is always visible. Values are looked up as own properties only, so a name such as "constructor"
 * is an unset value, never a member of Object.prototype. Several operators on one condition all must hold.
 * `values` may be null or undefined, which reads as an empty object. Not transitive: only the one referenced
 * setting's value is looked at, whether or not that setting is itself visible.
 */
export function isSettingVisible(
  descriptor: SettingDescriptor,
  values: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  const cond = descriptor.visibleIf;
  if (cond === undefined) return true;
  const own = values ?? {};
  const actual = Object.hasOwn(own, cond.setting) ? own[cond.setting] : undefined;
  if (Object.hasOwn(cond, "eq") && actual !== cond.eq) return false;
  if (Object.hasOwn(cond, "neq") && actual === cond.neq) return false;
  if (Object.hasOwn(cond, "in") && !(Array.isArray(cond.in) && cond.in.includes(actual))) return false;
  return true;
}
