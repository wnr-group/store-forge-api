import type { TemplateKind } from '../../../database/schema/templates.js';

/**
 * Server-side validation of a template document before it is saved or published.
 *
 * The Next.js template engine (`lib/templates/engine`) owns the per-setting rules (ranges, enums, colours) and the
 * renderer sanitises everything it prints. This validator is the API's own gate, so a client that skips the editor
 * still cannot store a malformed, oversized or unsafe document. It checks structure, limits, which section types
 * may appear on which page kind, ids, URLs and image references. When the frontend registry gains a section type, add
 * it to SECTION_TYPES here.
 */

/** The same numbers as the frontend's `lib/templates/limits.ts` (the database repeats maxDocumentBytes). */
export const DOCUMENT_LIMITS = Object.freeze({
  maxBlockDepth: 3,
  maxSectionsPerTemplate: 25,
  maxBlocksPerSection: 50,
  maxComponentsPerTemplate: 400,
  maxDocumentBytes: 262_144,
  maxTextLength: 5_000,
  maxRichtextLength: 20_000,
  maxValueDepth: 64,
});

export const DOCUMENT_SCHEMA_VERSION = 1;
export const LAYOUTS = ['classic', 'spotlight'] as const;

const SAFE_NODE_ID = /^(?!__proto__$)[A-Za-z0-9_-]{1,128}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Section types a page may hold, by template kind. */
const COMMON_SECTIONS = [
  'hero',
  'image-banner',
  'image-with-text',
  'featured-collection',
  'collection-list',
  'product-grid',
  'promotional-banner',
  'rich-text',
  'testimonials',
  'multicolumn',
  'logo-list',
  'collapsible-content',
  'announcement-bar',
] as const;

const SECTION_TYPES: Record<TemplateKind, readonly string[]> = {
  index: COMMON_SECTIONS,
  collection: [...COMMON_SECTIONS, 'collection-banner'],
  product: [...COMMON_SECTIONS, 'main-product', 'related-products'],
  theme_settings: [],
  group_header: ['announcement-bar', 'header'],
  group_footer: ['footer'],
  group_announcement: ['announcement-bar'],
};

/** Setting keys that hold a link. */
const URL_KEYS = new Set(['link', 'url', 'linkUrl']);

export interface DocumentIssue {
  path: string;
  message: string;
}

export interface ValidationContext {
  kind: TemplateKind;
  tenantId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A relative path, a fragment, or an absolute http(s)/mailto link with a plain host and no credentials. */
export function isSafeUrl(raw: string): boolean {
  if (raw.length > DOCUMENT_LIMITS.maxTextLength) return false;
  const url = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u001F\u007F]/.test(url)) return false;
  if (url.startsWith('#')) return true;
  if (url.startsWith('/')) return url[1] !== '/' && url[1] !== '\\';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'mailto:') return parsed.pathname.length > 0;
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  const authority = /^https?:\/\/([^/\\?#]*)/i.exec(url)?.[1];
  return (
    Boolean(authority) && !authority!.includes('@') && Boolean(parsed.hostname)
  );
}

/**
 * An image is either a file in the tenant's own storage folder (`{ path: "<tenantId>/store/<file>" }`) or a
 * platform-supplied theme asset (`{ asset: "<theme-slug>/<file>" }`, served from the storefront's /themes folder).
 */
function imageProblem(
  value: Record<string, unknown>,
  tenantId: string,
): string | null {
  const keys = Object.keys(value);
  if (keys.some((k) => !['path', 'asset', 'alt'].includes(k)))
    return 'Image has unknown fields.';
  if (
    'alt' in value &&
    (typeof value.alt !== 'string' || value.alt.length > 200)
  )
    return 'Image alt text must be at most 200 characters.';
  const hasPath = 'path' in value;
  const hasAsset = 'asset' in value;
  if (hasPath === hasAsset) return 'Image needs exactly one of path or asset.';
  if (hasPath) {
    const path = value.path;
    if (typeof path !== 'string') return 'Image path must be text.';
    if (
      !path.startsWith(`${tenantId}/store/`) ||
      path.includes('..') ||
      path.includes('\\') ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001F\u007F]/.test(path) ||
      path.length > 500
    )
      return "Image must be a file in this store's own image folder.";
    return null;
  }
  const asset = value.asset;
  if (
    typeof asset !== 'string' ||
    !/^[a-z][a-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(asset) ||
    asset.includes('..')
  )
    return 'Theme image reference is not valid.';
  return null;
}

class Walker {
  readonly issues: DocumentIssue[] = [];
  private components = 0;
  private readonly seenIds = new Set<string>(['__proto__']);

  constructor(private readonly ctx: ValidationContext) {}

  add(path: string, message: string) {
    if (this.issues.length < 50) this.issues.push({ path, message });
  }

  private value(path: string, key: string, v: unknown, depth: number) {
    if (depth > DOCUMENT_LIMITS.maxValueDepth)
      return this.add(path, 'Value is nested too deeply.');
    if (typeof v === 'string') {
      const max = DOCUMENT_LIMITS.maxRichtextLength;
      if (v.length > max) return this.add(path, 'Text is too long.');
      if (URL_KEYS.has(key) && v !== '' && !isSafeUrl(v))
        return this.add(
          path,
          'Link must be a relative path or an http(s) or mailto address.',
        );
      if (/^\s*(javascript|data|vbscript):/i.test(v))
        return this.add(path, 'Script and data addresses are not allowed.');
      if (/color/i.test(key) && v !== '' && !HEX_COLOR.test(v))
        return this.add(
          path,
          'Colours must be 6-digit hex values like #1a5aaa.',
        );
      return;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      if (typeof v === 'number' && !Number.isFinite(v))
        this.add(path, 'Numbers must be finite.');
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 200) return this.add(path, 'List is too long.');
      v.forEach((item, i) => this.value(`${path}[${i}]`, key, item, depth + 1));
      return;
    }
    if (isRecord(v)) {
      if ('path' in v || 'asset' in v) {
        const problem = imageProblem(v, this.ctx.tenantId);
        if (problem) this.add(path, problem);
        return;
      }
      for (const [k, child] of Object.entries(v)) {
        if (k === '__proto__') {
          this.add(`${path}.${k}`, 'That key is not allowed.');
          continue;
        }
        this.value(`${path}.${k}`, k, child, depth + 1);
      }
      return;
    }
    this.add(path, 'Unsupported value.');
  }

  private order(
    path: string,
    key: 'order' | 'block_order',
    nodes: Record<string, unknown>,
    order: unknown,
  ) {
    const at = path ? `${path}.${key}` : key;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
      this.add(at, 'Order must be a list of ids.');
      return;
    }
    const ids = Object.keys(nodes);
    const sameSet =
      order.length === ids.length &&
      new Set(order).size === order.length &&
      order.every((id) => Object.hasOwn(nodes, id as string));
    if (!sameSet) this.add(at, 'Order must list every item exactly once.');
  }

  private node(
    path: string,
    id: string,
    node: unknown,
    depth: number,
    isSection: boolean,
    counters: { blocks: number },
  ) {
    if (!SAFE_NODE_ID.test(id))
      this.add(path, 'Ids may use letters, digits, - and _ only.');
    else if (this.seenIds.has(id))
      this.add(path, 'Ids must be unique in the document.');
    this.seenIds.add(id);

    if (++this.components > DOCUMENT_LIMITS.maxComponentsPerTemplate)
      return this.add(path, 'The document has too many sections and blocks.');
    if (!isRecord(node)) return this.add(path, 'Must be an object.');

    const extra = Object.keys(node).filter(
      (k) =>
        !['type', 'settings', 'blocks', 'block_order', 'disabled'].includes(k),
    );
    if (extra.length) this.add(path, `Unknown fields: ${extra.join(', ')}.`);
    if (
      typeof node.type !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(node.type)
    )
      this.add(`${path}.type`, 'Type is required.');
    else if (isSection && !SECTION_TYPES[this.ctx.kind].includes(node.type))
      this.add(
        `${path}.type`,
        `A "${node.type}" section is not allowed on this page.`,
      );
    if ('disabled' in node && typeof node.disabled !== 'boolean')
      this.add(`${path}.disabled`, 'Must be true or false.');

    if (!isRecord(node.settings))
      this.add(`${path}.settings`, 'Must be an object.');
    else
      for (const [k, v] of Object.entries(node.settings))
        this.value(`${path}.settings.${k}`, k, v, 3);

    const blocks = node.blocks;
    if (!isRecord(blocks))
      return this.add(`${path}.blocks`, 'Must be an object.');
    this.order(path, 'block_order', blocks, node.block_order);
    if (!Array.isArray(node.block_order)) return;
    // A section is level 1; its blocks may nest maxBlockDepth levels below it.
    if (Object.keys(blocks).length && depth > DOCUMENT_LIMITS.maxBlockDepth)
      return this.add(`${path}.blocks`, 'Blocks are nested too deeply.');
    for (const [childId, child] of Object.entries(blocks)) {
      if (++counters.blocks > DOCUMENT_LIMITS.maxBlocksPerSection) {
        this.add(`${path}.blocks`, 'This section has too many blocks.');
        return;
      }
      this.node(
        `${path}.blocks.${childId}`,
        childId,
        child,
        depth + 1,
        false,
        counters,
      );
    }
  }

  page(doc: Record<string, unknown>) {
    if (!(LAYOUTS as readonly string[]).includes(doc.layout as string))
      this.add('layout', 'Layout must be "classic" or "spotlight".');
    const sections = doc.sections;
    if (!isRecord(sections)) return this.add('sections', 'Must be an object.');
    if (Object.keys(sections).length > DOCUMENT_LIMITS.maxSectionsPerTemplate)
      this.add('sections', 'The page has too many sections.');
    this.order('', 'order', sections, doc.order);
    for (const [id, section] of Object.entries(sections))
      this.node(`sections.${id}`, id, section, 1, true, { blocks: 0 });
  }

  themeSettings(doc: Record<string, unknown>) {
    if (!isRecord(doc.settings))
      return this.add('settings', 'Must be an object.');
    const groups = [
      'brand',
      'colors',
      'typography',
      'layout',
      'buttons',
      'productCards',
      'productPage',
      'social',
    ];
    for (const [group, values] of Object.entries(doc.settings)) {
      if (!groups.includes(group)) {
        this.add(`settings.${group}`, 'Unknown settings group.');
        continue;
      }
      if (!isRecord(values)) {
        this.add(`settings.${group}`, 'Must be an object.');
        continue;
      }
      for (const [k, v] of Object.entries(values)) {
        if (group === 'colors' && !(typeof v === 'string' && HEX_COLOR.test(v)))
          this.add(
            `settings.colors.${k}`,
            'Colours must be 6-digit hex values like #1a5aaa.',
          );
        else this.value(`settings.${group}.${k}`, k, v, 3);
      }
    }
  }
}

/** Returns every problem found (at most 50). An empty list means the document is acceptable. */
export function validateTemplateDocument(
  doc: unknown,
  ctx: ValidationContext,
): DocumentIssue[] {
  const walker = new Walker(ctx);
  if (!isRecord(doc))
    return [{ path: '', message: 'The document must be an object.' }];
  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (bytes > DOCUMENT_LIMITS.maxDocumentBytes)
    return [{ path: '', message: 'The document is too large.' }];
  if (doc.schemaVersion !== DOCUMENT_SCHEMA_VERSION)
    walker.add(
      'schemaVersion',
      `Schema version must be ${DOCUMENT_SCHEMA_VERSION}.`,
    );
  if (ctx.kind === 'theme_settings') walker.themeSettings(doc);
  else walker.page(doc);
  return walker.issues;
}
