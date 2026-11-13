// GENERATED from wnr-group/store-forge lib/templates/engine/image-scan.ts. DO NOT EDIT.

import { IMAGE_ISSUE_CODES, imagePathViolation, imageValueMessage, type ImageIssueCode } from "./schema.js";

type Entry = { value: unknown; path: string };

function isImageShaped(value: unknown): value is { path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

/** An object with a `path` key that is not text: a malformed image, never silently accepted. */
function isMalformedImage(value: object): boolean {
  return Object.hasOwn(value, "path") && typeof (value as { path?: unknown }).path !== "string";
}

function childPath(parent: string, key: string | number): string {
  return parent ? `${parent}.${key}` : String(key);
}

/**
 * Reports `value` itself when it is an image-shaped object (a string `path`) that breaks the image-path rule, or
 * an object whose `path` is not text; does not look inside it. `scanImageValues` applies it to every object it
 * reaches; the validator also applies it to a section, a block and the document root, whose own keys it scans
 * one by one, so a `path` sitting directly on one of them is vetted too.
 */
export function checkImageShape(
  value: object,
  path: string,
  tenantId: string | undefined,
  report: (path: string, code: ImageIssueCode, message: string) => void,
): void {
  if (isImageShaped(value)) {
    const violation = imagePathViolation(value.path, tenantId);
    if (violation) report(path, violation, imageValueMessage(violation));
  } else if (isMalformedImage(value)) {
    report(path, IMAGE_ISSUE_CODES.invalidImage, imageValueMessage(IMAGE_ISSUE_CODES.invalidImage));
  }
}

/**
 * Finds image-shaped values (an object with a string `path`) anywhere under `root`, at any depth and
 * inside arrays, and reports each one that breaks the shared image-path rule, plus any object whose `path` is not text. This covers what the
 * descriptors cannot: unknown component types, undeclared setting keys and the free-form theme settings
 * object, so a foreign path cannot be smuggled through them (D11, AC-ENG-016). The rule itself lives in
 * `imagePathViolation`; this file only locates values. The walk is iterative so deeply nested input
 * cannot overflow the call stack. When `reportProtoKey` is given it is also called for every object under
 * `root` that has an own `__proto__` key.
 */
export function scanImageValues(
  root: unknown,
  rootPath: string,
  tenantId: string | undefined,
  report: (path: string, code: ImageIssueCode, message: string) => void,
  reportProtoKey?: (path: string) => void,
): void {
  const stack: Entry[] = [{ value: root, path: rootPath }];
  while (stack.length > 0) {
    const { value, path } = stack.pop() as Entry;
    if (typeof value !== "object" || value === null) continue;

    // Primitive children (the bulk of a wide document) can never be images: they are skipped before any
    // entry or path string is built, so only object and array children cost anything.
    const children: Entry[] = [];
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item: unknown = value[index];
        if (typeof item === "object" && item !== null) children.push({ value: item, path: childPath(path, index) });
      }
    } else {
      // An own `__proto__` key (JSON.parse creates one) is never legitimate data here; the same single walk finds it.
      if (reportProtoKey && Object.hasOwn(value, "__proto__")) reportProtoKey(childPath(path, "__proto__"));
      checkImageShape(value, path, tenantId, report);
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const item: unknown = (value as Record<string, unknown>)[key];
        if (typeof item === "object" && item !== null) children.push({ value: item, path: childPath(path, key) });
      }
    }
    // Reversed so the walk reports in document order.
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}
