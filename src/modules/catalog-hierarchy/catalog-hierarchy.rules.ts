import { slugify } from '../../common/utils/slug.js';

/**
 * Pure rules of the catalog hierarchy (no database). The database enforces the same rules with triggers
 * (migration 0072); these functions exist so the API can answer with a precise, friendly message first, and so the
 * import can validate a whole file without touching the database.
 */

/** Technical safety limits (not plan limits: V1 has no catalog entitlement). */
export const MAX_LEVELS = 20;
export const MAX_NODES_PER_HIERARCHY = 100_000;
/** Products per assign / unassign request. */
export const MAX_PRODUCTS_PER_REQUEST = 500;
/** Nodes per bulk assignment request, and the largest node x product grid. */
export const MAX_NODES_PER_REQUEST = 100;
export const MAX_ASSIGNMENT_PAIRS = 20_000;
/** The admin tree and the public tree return at most this many nodes (the response says when it was cut). */
export const MAX_TREE_NODES = 5000;

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The address segment of a node, made from its name. Never empty, at most 80 characters. */
export function nodeSlugFromName(name: string): string {
  return slugify(name).slice(0, 80).replace(/-+$/g, '') || 'item';
}

/** `base`, or `base-2`, `base-3`... the first one not in `taken`. The result stays within 80 characters. */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface LevelRef {
  id: string;
  name: string;
}

/** What the existing nodes need from the order of the levels. */
export interface LevelUsage {
  /** Distinct (parent level, child level) pairs that occur in the tree. */
  pairs: { parentLevelId: string; childLevelId: string }[];
  /** Levels that have root nodes (those must stay first). */
  rootLevelIds: string[];
}

/**
 * Would putting the levels in `order` (first = level 1) keep every existing relation valid? A child must be on the level
 * right after its parent's, and roots must be on level 1. Returns one message per broken relation (empty = safe).
 * Levels without nodes can be moved freely; this is what makes a reorder "safe".
 */
export function reorderProblems(
  order: readonly LevelRef[],
  usage: LevelUsage,
): string[] {
  const position = new Map(order.map((l, i) => [l.id, i + 1]));
  const name = new Map(order.map((l) => [l.id, l.name]));
  const problems: string[] = [];
  for (const id of usage.rootLevelIds)
    if (position.get(id) !== 1)
      problems.push(
        `"${name.get(id)}" has top-level items, so it has to stay the first level.`,
      );
  for (const { parentLevelId, childLevelId } of usage.pairs) {
    const p = position.get(parentLevelId);
    const c = position.get(childLevelId);
    if (p === undefined || c === undefined || c !== p + 1)
      problems.push(
        `"${name.get(childLevelId)}" items sit under "${name.get(parentLevelId)}" items, so "${name.get(childLevelId)}" has to stay directly after "${name.get(parentLevelId)}".`,
      );
  }
  return [...new Set(problems)];
}

export interface TreeNodeBase {
  id: string;
  parentId: string | null;
  position: number;
  name: string;
}

export type TreeOf<T> = T & { children: TreeOf<T>[] };

/** Flat nodes to a nested tree. A node whose parent is not in the list becomes a root of the result. */
export function buildTree<T extends TreeNodeBase>(
  nodes: readonly T[],
): TreeOf<T>[] {
  const byId = new Map<string, TreeOf<T>>(
    nodes.map((n) => [n.id, { ...n, children: [] }]),
  );
  const roots: TreeOf<T>[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const order = (a: TreeOf<T>, b: TreeOf<T>) =>
    a.position - b.position ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id);
  const sort = (list: TreeOf<T>[]) => {
    list.sort(order);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}
