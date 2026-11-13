// GENERATED from wnr-group/store-forge lib/templates/engine/size.ts. DO NOT EDIT.

/**
 * The size the database measures (D6). The `templates` and version tables hold the document as JSONB and
 * CHECK `octet_length(document::text) <= 262144`, so the byte count that matters is the UTF-8 length of the
 * jsonb TEXT form, not of `JSON.stringify` output: jsonb prints `": "` after every key, `", "` between
 * elements and `{}` / `[]` for empty containers, which makes the stored form noticeably longer than the
 * compact JSON (a 261,268-byte compact document is 310,782 bytes as jsonb text).
 *
 * `jsonbByteLength` computes that length without building the string, iteratively (a document nested
 * thousands of levels deep cannot overflow the call stack), and follows `JSON.stringify` for everything the
 * input side does: `undefined`, functions and symbols are dropped from objects and become `null` in arrays,
 * non-finite numbers are `null`, `toJSON` is honoured, a cycle or a bigint throws a TypeError.
 *
 * Key order is irrelevant to the length (jsonb sorts keys) and duplicate keys cannot exist in a JS object.
 * Strings use the JSON.stringify escaping, which is what jsonb prints for quotes, backslashes, `\b \f \n \r \t`
 * and the other control characters (`\u00XX`).
 *
 * Known differences, all in the SAFE direction or unstorable anyway:
 * - Numbers: jsonb stores `numeric` and prints it in plain decimal notation, never an exponent (1e21 is
 *   `1000000000000000000000`, 1e-7 is `0.0000001`). This function expands JS's shortest round-trip digits
 *   the same way, so the lengths match exactly.
 * - Boxed primitives (`new Number(1)`) are not unwrapped; documents are plain JSON data.
 *
 * Two kinds of document are refused instead of measured, each with a dedicated error:
 * - `ValueDepthError`: a container nested deeper than LIMITS.maxValueDepth (checked on the frame stack before
 *   a level is opened, so the function stays iterative and the refusal costs at most that many frames). Such a
 *   value could not be serialized or cloned by the save path anyway.
 * - `UnstorableTextError`: a string or key containing a NUL code unit or an unpaired surrogate. PostgreSQL jsonb
 *   refuses both at insert time (U+0000: "unsupported Unicode escape sequence"; a lone surrogate escape:
 *   "Unicode high/low surrogate must follow ..."), so no stored document can contain one. A valid surrogate
 *   pair (an emoji) and every other control character (U+0001, U+001F, U+007F, U+2028) are fine. It is thrown
 *   only AFTER the whole traversal succeeded: a cycle, a bigint or a depth failure found anywhere wins over it,
 *   so a caller that goes on after this error knows the document is acyclic and within the depth limit.
 */
import { LIMITS } from "../limits.js";

/** A value is nested deeper than LIMITS.maxValueDepth. */
export class ValueDepthError extends TypeError {
  constructor() {
    super(`Value is nested deeper than ${LIMITS.maxValueDepth} levels`);
    this.name = "ValueDepthError";
  }
}

/** A string or key holds a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store. */
export class UnstorableTextError extends TypeError {
  constructor() {
    super("Text cannot contain NUL characters or unpaired surrogates");
    this.name = "UnstorableTextError";
  }
}

type Container = Record<string, unknown> | unknown[];

interface Frame {
  owner: Container;
  /** Resolved child values, already filtered the way JSON.stringify filters them. */
  values: unknown[];
  /** Escaped-key byte lengths (object frames only), parallel to `values`. */
  keyBytes: number[] | null;
  next: number;
}

/** What the traversal noticed on the way; read after it has finished. */
interface MeasureState {
  /** A NUL or an unpaired surrogate was seen in a string or key. */
  unstorable: boolean;
}

/**
 * JSON string, quotes included, in UTF-8 bytes: escapes as JSON.stringify writes them, the rest as UTF-8.
 * A NUL or an unpaired surrogate (keys and values both come through here) is not counted and sets
 * `state.unstorable` instead of throwing: the traversal goes on, so the cycle and depth guards still run, and
 * `jsonbByteLength` throws UnstorableTextError once the whole document has been traversed.
 */
function stringBytes(value: string, state: MeasureState): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      state.unstorable = true;
    } else if (code < 0x20) {
      // \b \t \n \f \r are two characters, every other control character is \u00XX.
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        state.unstorable = true; // lone high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      state.unstorable = true; // lone low surrogate
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Characters of the plain-decimal text of a finite number, as PostgreSQL's numeric output prints it. */
function numberBytes(value: number): number {
  if (!Number.isFinite(value)) return 4; // null
  if (value === 0) return 1; // 0 and -0 both stringify as "0"
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.length - (mantissa.includes(".") ? 1 : 0);
  const exponent = Number(exponentText);
  let length: number;
  if (exponent >= 0) {
    // Digits before the point: exponent + 1. Fewer digits than that are padded with zeros, more get a point.
    length = digits <= exponent + 1 ? exponent + 1 : digits + 1;
  } else {
    length = 2 + (-exponent - 1) + digits; // "0." + leading zeros + digits
  }
  return value < 0 ? length + 1 : length;
}

/** `toJSON` applied the way JSON.stringify applies it. */
function resolveJson(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") return (toJson as () => unknown).call(value);
  }
  return value;
}

/** Values JSON.stringify leaves out of an object (and writes as `null` inside an array). */
const isOmitted = (value: unknown): boolean => value === undefined || typeof value === "function" || typeof value === "symbol";

function makeFrame(owner: Container, state: MeasureState): Frame {
  const values: unknown[] = [];
  if (Array.isArray(owner)) {
    for (let i = 0; i < owner.length; i++) {
      const resolved = resolveJson(owner[i]);
      values.push(isOmitted(resolved) ? null : resolved);
    }
    return { owner, values, keyBytes: null, next: 0 };
  }
  const keyBytes: number[] = [];
  for (const key of Object.keys(owner)) {
    const resolved = resolveJson(owner[key]);
    if (isOmitted(resolved)) continue;
    keyBytes.push(stringBytes(key, state));
    values.push(resolved);
  }
  return { owner, values, keyBytes, next: 0 };
}

/**
 * UTF-8 byte length of `value` as PostgreSQL prints it with `value::jsonb::text`. Throws a TypeError for a
 * cycle or a bigint, like JSON.stringify, a ValueDepthError (also a TypeError) for a value nested deeper than
 * LIMITS.maxValueDepth and an UnstorableTextError for a NUL or unpaired surrogate. A root that JSON.stringify
 * would omit (undefined, a function) counts as 0.
 */
export function jsonbByteLength(value: unknown): number {
  const root = resolveJson(value);
  if (isOmitted(root)) return 0;

  let total = 0;
  const state: MeasureState = { unstorable: false };
  const stack: Frame[] = [];
  const open = new Set<object>();

  /** Counts a resolved, non-omitted value; a non-empty container opens a frame instead and counts its closing later. */
  const emit = (item: unknown): void => {
    if (typeof item === "object" && item !== null) {
      if (open.has(item)) throw new TypeError("Converting circular structure to JSON");
      // This container would be level `stack.length + 1` (empty ones count too: they are still a level).
      if (stack.length >= LIMITS.maxValueDepth) throw new ValueDepthError();
      const frame = makeFrame(item as Container, state);
      if (frame.values.length === 0) {
        total += 2; // {} or []
        return;
      }
      open.add(item);
      total += 1; // opening bracket; the closing one is counted when the frame is done
      stack.push(frame);
    } else if (typeof item === "string") {
      total += stringBytes(item, state);
    } else if (typeof item === "number") {
      total += numberBytes(item);
    } else if (typeof item === "boolean") {
      total += item ? 4 : 5;
    } else if (item === null) {
      total += 4;
    } else {
      throw new TypeError("Do not know how to serialize a BigInt");
    }
  };

  emit(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next === frame.values.length) {
      total += 1; // closing bracket
      open.delete(frame.owner);
      stack.pop();
      continue;
    }
    if (frame.next > 0) total += 2; // ", "
    if (frame.keyBytes) total += frame.keyBytes[frame.next] + 2; // key and ": "
    emit(frame.values[frame.next++]);
  }
  // Only now, with the document known to be acyclic and within the depth limit, is unstorable text reported.
  if (state.unstorable) throw new UnstorableTextError();
  return total;
}
