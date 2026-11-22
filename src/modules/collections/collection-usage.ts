import { createHash } from 'node:crypto';

/** Section types whose `settings.collectionId` names a collection (the frontend registry has one: featured-collection). */
export const COLLECTION_REF_SECTION_TYPES: ReadonlySet<string> = new Set([
  'featured-collection',
]);
const MAX_DEPTH = 64;

export interface RawRef {
  sectionId: string;
  path: string;
}
export interface TemplateSource {
  id: string;
  name: string;
  kind: string;
  draft: unknown;
  published: unknown;
}
export interface UsageRef {
  templateId: string;
  templateName: string;
  kind: string;
  location: string;
  sectionId: string;
  inDraft: boolean;
  inPublished: boolean;
}
export interface CollectionUsage {
  total: number;
  hash: string;
  references: UsageRef[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sections of `doc` that point at `target` through `settings.collectionId` (its id or current slug). URLs and other text are
 * never read. A disabled section still counts: re-enabling it would hide it again.
 */
export function findCollectionRefs(
  doc: unknown,
  target: { id: string; slug: string },
): RawRef[] {
  const out: RawRef[] = [];
  const walk = (value: unknown, path: string, key: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, String(i), depth + 1));
      return;
    }
    if (!isObj(value)) return;
    if (
      typeof value.type === 'string' &&
      COLLECTION_REF_SECTION_TYPES.has(value.type) &&
      isObj(value.settings)
    ) {
      const raw = value.settings.collectionId;
      const ref = typeof raw === 'string' ? raw.trim() : '';
      if (ref !== '' && (ref === target.id || ref === target.slug))
        out.push({ sectionId: key, path });
    }
    for (const [k, v] of Object.entries(value))
      walk(v, path ? `${path}.${k}` : k, k, depth + 1);
  };
  walk(doc, '', '', 0);
  return out;
}

/** Where a reference lives, in words a merchant knows: the page kind, or the generated page ("cart page"). */
export const locationOf = (kind: string, path: string): string => {
  const m = /^settings\.pages\.([^.]+)\./.exec(path);
  return m ? `${m[1]} page` : kind;
};

export function computeUsage(
  sources: TemplateSource[],
  target: { id: string; slug: string },
): CollectionUsage {
  const found = new Map<string, UsageRef>();
  const add = (
    t: TemplateSource,
    refs: RawRef[],
    from: 'draft' | 'published',
  ) => {
    for (const r of refs) {
      const key = `${t.id}|${r.path}`;
      const cur: UsageRef = found.get(key) ?? {
        templateId: t.id,
        templateName: t.name,
        kind: t.kind,
        location: locationOf(t.kind, r.path),
        sectionId: r.sectionId,
        inDraft: false,
        inPublished: false,
      };
      if (from === 'draft') cur.inDraft = true;
      else cur.inPublished = true;
      found.set(key, cur);
    }
  };
  for (const t of sources) {
    add(t, findCollectionRefs(t.draft, target), 'draft');
    if (t.published)
      add(t, findCollectionRefs(t.published, target), 'published');
  }
  const references = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  const hash = createHash('sha256')
    .update(
      references
        .map(
          (r) =>
            `${r.templateId}|${r.sectionId}|${r.location}|${+r.inDraft}${+r.inPublished}`,
        )
        .join('\n'),
    )
    .digest('hex');
  return { total: references.length, hash, references };
}
