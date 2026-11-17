import type { DocumentIssue } from './template-document.js';

/**
 * Server-side validation of a product presentation document (migration 0032) before it is saved or published.
 *
 * A closed schema: only the keys below are accepted, every one is optional, and an omitted key means "inherit the
 * store's theme and product page". Catalogue fields (name, price, description, images) and free text, links and
 * colours have no place here. The values mirror the storefront registry (`lib/templates/registry`):
 *   - gallery.layout / gallery.mediaPosition are the `galleryLayout` / `mediaPosition` options of `main-product`;
 *   - focalPoint is the `{ x, y }` percentage pair the image block uses for `object-position`;
 *   - hiddenBlocks lists registry block types (and the `related-products` section) the product page may hide.
 * Card settings are deliberately not supported yet (no frontend contract): a `card` key is rejected as unknown.
 */

export const PRESENTATION_SCHEMA_VERSION = 1;
export const GALLERY_LAYOUTS = ['thumbnails', 'stacked'] as const;
export const MEDIA_POSITIONS = ['left', 'right'] as const;
/** Descriptive blocks only. Title and price are deliberately not hideable. */
export const HIDEABLE_BLOCKS = [
  'product-description',
  'product-sku',
  'product-type',
  'product-category',
  'social-share',
  'related-products',
] as const;
export const PRESENTATION_MAX_BYTES = 4_096;

const ROOT_KEYS = ['schemaVersion', 'gallery', 'focalPoint', 'hiddenBlocks'];

/** An empty document: everything inherits. */
export const EMPTY_PRESENTATION = Object.freeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: DocumentIssue[],
) {
  for (const k of Object.keys(obj))
    if (!allowed.includes(k))
      issues.push({
        path: path ? `${path}.${k}` : k,
        message: 'This setting is not supported.',
      });
}

/** Returns every problem found. An empty list means the document is acceptable. */
export function validatePresentationDocument(doc: unknown): DocumentIssue[] {
  if (!isRecord(doc))
    return [{ path: '', message: 'The document must be an object.' }];
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  } catch {
    return [{ path: '', message: 'The document is not valid.' }];
  }
  if (bytes > PRESENTATION_MAX_BYTES)
    return [{ path: '', message: 'The document is too large.' }];

  const issues: DocumentIssue[] = [];
  unknownKeys(doc, ROOT_KEYS, '', issues);

  if (doc.schemaVersion !== PRESENTATION_SCHEMA_VERSION)
    issues.push({
      path: 'schemaVersion',
      message: `Schema version must be ${PRESENTATION_SCHEMA_VERSION}.`,
    });

  if ('gallery' in doc) {
    const g = doc.gallery;
    if (!isRecord(g))
      issues.push({ path: 'gallery', message: 'Must be an object.' });
    else {
      unknownKeys(g, ['layout', 'mediaPosition'], 'gallery', issues);
      if (
        'layout' in g &&
        !(GALLERY_LAYOUTS as readonly unknown[]).includes(g.layout)
      )
        issues.push({
          path: 'gallery.layout',
          message: `Layout must be one of: ${GALLERY_LAYOUTS.join(', ')}.`,
        });
      if (
        'mediaPosition' in g &&
        !(MEDIA_POSITIONS as readonly unknown[]).includes(g.mediaPosition)
      )
        issues.push({
          path: 'gallery.mediaPosition',
          message: `Media position must be one of: ${MEDIA_POSITIONS.join(', ')}.`,
        });
    }
  }

  if ('focalPoint' in doc) {
    const f = doc.focalPoint;
    if (!isRecord(f))
      issues.push({ path: 'focalPoint', message: 'Must be an object.' });
    else {
      unknownKeys(f, ['x', 'y'], 'focalPoint', issues);
      for (const axis of ['x', 'y'] as const) {
        const v = f[axis];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)
          issues.push({
            path: `focalPoint.${axis}`,
            message: `${axis} must be a number from 0 to 100.`,
          });
      }
    }
  }

  if ('hiddenBlocks' in doc) {
    const h = doc.hiddenBlocks;
    if (!Array.isArray(h))
      issues.push({ path: 'hiddenBlocks', message: 'Must be a list.' });
    else {
      const seen = new Set<unknown>();
      h.forEach((item, i) => {
        if (!(HIDEABLE_BLOCKS as readonly unknown[]).includes(item))
          issues.push({
            path: `hiddenBlocks[${i}]`,
            message: 'That block cannot be hidden.',
          });
        else if (seen.has(item))
          issues.push({
            path: `hiddenBlocks[${i}]`,
            message: 'Each block can be listed once.',
          });
        seen.add(item);
      });
    }
  }

  return issues.slice(0, 50);
}
