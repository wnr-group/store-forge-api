// GENERATED from wnr-group/store-forge lib/templates/engine/migrate.ts. DO NOT EDIT.

import { DEFAULT_LAYOUT, DOCUMENT_SCHEMA_VERSION, PAGE_KINDS, type TemplateDocument, type TemplateKind } from "../document.js";

/** One migration step: takes a document at version N and returns it at the shape of version N + 1. */
export type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration steps keyed by the version they migrate FROM. Empty today: schemaVersion 1 is the current
 * version and the identity. A future version 2 adds `1: (doc) => ...` here and bumps DOCUMENT_SCHEMA_VERSION;
 * no caller changes.
 */
export const MIGRATION_STEPS: Readonly<Record<number, MigrationStep>> = Object.freeze({});

const isPageKind = (kind: TemplateKind): boolean => (PAGE_KINDS as readonly string[]).includes(kind);

/** Plain data only: an Object.prototype or null-prototype object. Arrays, Dates, Maps and class instances are not. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Pure chain: runs `steps[from]`, `steps[from + 1]`, ... until the document is at `to`, stamping each new
 * schemaVersion. Never mutates `doc`; a missing step is an error rather than a silent skip.
 */
export function applyMigrationSteps(
  doc: Record<string, unknown>,
  from: number,
  to: number,
  steps: Readonly<Record<number, MigrationStep>>,
): Record<string, unknown> {
  let current = doc;
  for (let version = from; version < to; version++) {
    const step = Object.hasOwn(steps, version) ? steps[version] : undefined;
    if (!step) throw new Error(`No migration step from schemaVersion ${version} to ${version + 1}`);
    const next: unknown = step(current);
    if (!isPlainObject(next)) {
      throw new Error(`Migration step from schemaVersion ${version} to ${version + 1} must return an object`);
    }
    current = { ...next, schemaVersion: version + 1 };
  }
  return current;
}

/**
 * Migrate-on-read for template documents (D3, R3, AC-ENG-015): returns the document at the current
 * schemaVersion and never drops a key (theme `settings`, unknown extra keys and group documents without a
 * `layout` all survive). At schemaVersion 1 the content is the input unchanged, except that a page kind
 * (index, product, collection) with no `layout` gets `classic`; group and theme kinds never get one.
 *
 * The result is always a structured clone, so it never aliases the input and the input is never mutated
 * (it may be frozen). schemaVersion must be a positive integer no newer than DOCUMENT_SCHEMA_VERSION; the
 * database guarantees it (D6), so anything else is rejected rather than guessed at.
 */
export function migrateDocument(kind: TemplateKind, raw: unknown): TemplateDocument {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid document: expected an object");
  }

  // An own property only: a version inherited from a prototype is not part of the stored document.
  const version = Object.hasOwn(raw, "schemaVersion") ? raw.schemaVersion : undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > DOCUMENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schemaVersion: ${String(version)}. Current supported version is ${DOCUMENT_SCHEMA_VERSION}`,
    );
  }

  const migrated = applyMigrationSteps(structuredClone(raw), version, DOCUMENT_SCHEMA_VERSION, MIGRATION_STEPS);
  // A page kind needs a layout, so an absent, null or empty one gets the default; any other string is the validator's call.
  if (isPageKind(kind) && (migrated.layout === undefined || migrated.layout === null || migrated.layout === "")) {
    migrated.layout = DEFAULT_LAYOUT;
  }
  return migrated as unknown as TemplateDocument;
}
