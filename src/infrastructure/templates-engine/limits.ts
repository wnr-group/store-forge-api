// GENERATED from wnr-group/store-forge lib/templates/limits.ts. DO NOT EDIT.

/**
 * Central limits for the template engine (decisions D6 and D27). Plain constants with no imports, so the
 * Drizzle schema, the validator, the services and the editor all read the same numbers.
 * The database repeats MAX_DOCUMENT_BYTES in a CHECK constraint (D6); everything else is enforced in the app.
 */
export const LIMITS = Object.freeze({
  /** Block nesting levels under a section (section > block > block > block). */
  maxBlockDepth: 3,
  maxSectionsPerTemplate: 25,
  /** Blocks per section, counted over all levels. */
  maxBlocksPerSection: 50,
  /** Sections plus blocks in one document. */
  maxComponentsPerTemplate: 400,
  maxDocumentBytes: 262_144,
  maxTextLength: 5_000,
  /** Alt text of an image value. */
  maxAltLength: 200,
  maxRichtextLength: 20_000,
  maxActiveTemplatesPerStore: 100,
  maxArchivedTemplatesPerStore: 500,
  maxVersionsPerTemplate: 500,
  maxNameLength: 80,
  maxVersionLabelLength: 80,
  /**
   * Nesting levels of any JSON value in a document (every object or array on the path counts, the document
   * itself is level 1). A generic guard, separate from maxBlockDepth: JSON.stringify and the clone the save path
   * makes recurse, so a value thousands of levels deep would crash them even when it is far below the 256 KB limit.
   * 64 is far below V8's recursion limit (thousands of frames) and far above any real value: a section with the
   * deepest allowed block nesting (3 levels, 2 value levels each) plus its settings stays under 20.
   */
  maxValueDepth: 64,
} as const);
