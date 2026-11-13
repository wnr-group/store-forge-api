// GENERATED from wnr-group/store-forge lib/templates/engine/tree-ids.ts. DO NOT EDIT.

import type { ComponentNode, TemplateDocument } from "../document.js";

/** Random bytes per generated id: 48 bits keep 10,000 ids collision-free in practice. */
const ID_RANDOM_BYTES = 6;

/** Ids look like `blk_1a2b3c4d5e6f`. Uses Web Crypto, which browsers and Node both provide as a global. */
export function generateId(prefix = "c"): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
    throw new Error("Cannot generate an id: Web Crypto is not available in this environment");
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

/** Tries per id before a generator that keeps returning taken ids is declared broken. */
export const MAX_ID_ATTEMPTS = 50;

/**
 * A custom id becomes an object key and a path segment: letters, digits, `-` and `_` only, 1 to 128 characters.
 * `__proto__` is refused: as a key it is a trap (assignment swaps the prototype, spreads and Zod drop it). The other
 * prototype names (`constructor`, `toString`, ...) are safe through own-property handling and stay allowed.
 */
export const SAFE_NODE_ID_REGEX = /^(?!__proto__$)[A-Za-z0-9_-]{1,128}$/;

/** Every id in the document, sections and blocks at all depths: ids are unique across both kinds. `__proto__` always counts as taken. */
export function collectUsedIds(doc: TemplateDocument): Set<string> {
  const used = new Set<string>(["__proto__"]);
  const collect = (id: string, node: ComponentNode) => {
    used.add(id);
    for (const [childId, child] of Object.entries(node.blocks || {})) collect(childId, child);
  };
  for (const [id, section] of Object.entries(doc.sections || {})) collect(id, section);
  return used;
}
