// GENERATED from wnr-group/store-forge lib/templates/engine/measure.ts. DO NOT EDIT.

import { jsonbByteLength, UnstorableTextError, ValueDepthError } from "./size.js";

/** The outcome of measuring a document: its jsonb byte length, or the error the measurement threw. */
export type Measured = { bytes: number } | { error: unknown };

/** Measures `input` the way the database does; never throws (the failure is returned instead). */
export function measureDocument(input: unknown): Measured {
  try {
    return { bytes: jsonbByteLength(input) };
  } catch (error) {
    return { error };
  }
}

/** True when the measurement failed because a value is nested deeper than LIMITS.maxValueDepth. */
export const isDepthFailure = (measured: Measured): measured is { error: ValueDepthError } =>
  "error" in measured && measured.error instanceof ValueDepthError;

/** The error issue (code and message) for a failed measurement. */
export function measureFailureIssue(error: unknown): { code: string; message: string } {
  if (error instanceof ValueDepthError) {
    return { code: "DEPTH_EXCEEDED", message: "Values in the document are nested too deeply" };
  }
  if (error instanceof UnstorableTextError) {
    return { code: "UNSUPPORTED_TEXT", message: "Text cannot contain NUL characters or unpaired surrogates" };
  }
  return { code: "SERIALIZATION_ERROR", message: "Document cannot be serialized to JSON" };
}
