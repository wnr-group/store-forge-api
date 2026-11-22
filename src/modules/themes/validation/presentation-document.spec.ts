import { describe, expect, it } from 'vitest';
import {
  EMPTY_PRESENTATION,
  HIDEABLE_BLOCKS,
  validatePresentationDocument as validate,
} from './presentation-document.js';

const ok = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  ...extra,
});
const paths = (doc: unknown) => validate(doc).map((i) => i.path);

describe('validatePresentationDocument', () => {
  it('accepts the empty document and every supported setting', () => {
    expect(validate(EMPTY_PRESENTATION)).toEqual([]);
    expect(
      validate(
        ok({
          gallery: { layout: 'stacked', mediaPosition: 'right' },
          focalPoint: { x: 0, y: 100 },
          hiddenBlocks: [...HIDEABLE_BLOCKS],
        }),
      ),
    ).toEqual([]);
    expect(validate(ok({ gallery: {} }))).toEqual([]);
    expect(validate(ok({ focalPoint: { x: 12.5, y: 33.33 } }))).toEqual([]);
  });

  it('rejects non-objects and a wrong or missing schema version', () => {
    for (const bad of [null, [], 'x', 3, undefined])
      expect(validate(bad)).toHaveLength(1);
    expect(paths({})).toContain('schemaVersion');
    expect(paths({ schemaVersion: 2 })).toContain('schemaVersion');
    expect(paths({ schemaVersion: '1' })).toContain('schemaVersion');
  });

  it('is a closed schema: unknown keys are rejected at every level', () => {
    expect(paths(ok({ card: {} }))).toEqual(['card']);
    expect(paths(ok({ price: 1 }))).toEqual(['price']);
    expect(paths(ok({ gallery: { zoom: true } }))).toEqual(['gallery.zoom']);
    expect(paths(ok({ focalPoint: { x: 1, y: 1, z: 1 } }))).toEqual([
      'focalPoint.z',
    ]);
    expect(
      paths(JSON.parse('{"schemaVersion":1,"__proto__":{"a":1}}')),
    ).toEqual(['__proto__']);
  });

  it('checks gallery values', () => {
    expect(paths(ok({ gallery: { layout: 'grid' } }))).toEqual([
      'gallery.layout',
    ]);
    expect(paths(ok({ gallery: { mediaPosition: 'top' } }))).toEqual([
      'gallery.mediaPosition',
    ]);
    expect(paths(ok({ gallery: 'stacked' }))).toEqual(['gallery']);
    expect(paths(ok({ gallery: null }))).toEqual(['gallery']);
  });

  it('checks the focal point range and types', () => {
    expect(paths(ok({ focalPoint: { x: -1, y: 50 } }))).toEqual([
      'focalPoint.x',
    ]);
    expect(paths(ok({ focalPoint: { x: 50, y: 100.1 } }))).toEqual([
      'focalPoint.y',
    ]);
    expect(paths(ok({ focalPoint: { x: '50', y: 50 } }))).toEqual([
      'focalPoint.x',
    ]);
    expect(paths(ok({ focalPoint: { x: Number.NaN, y: 50 } }))).toEqual([
      'focalPoint.x',
    ]);
    expect(paths(ok({ focalPoint: { x: 50 } }))).toEqual(['focalPoint.y']);
    expect(paths(ok({ focalPoint: [] }))).toEqual(['focalPoint']);
  });

  it('only allows the known hideable blocks, once each', () => {
    expect(paths(ok({ hiddenBlocks: ['product-title'] }))).toEqual([
      'hiddenBlocks[0]',
    ]);
    expect(paths(ok({ hiddenBlocks: ['product-price'] }))).toEqual([
      'hiddenBlocks[0]',
    ]);
    expect(paths(ok({ hiddenBlocks: ['inventory'] }))).toEqual([
      'hiddenBlocks[0]',
    ]);
    expect(paths(ok({ hiddenBlocks: [1] }))).toEqual(['hiddenBlocks[0]']);
    expect(paths(ok({ hiddenBlocks: ['product-sku', 'product-sku'] }))).toEqual(
      ['hiddenBlocks[1]'],
    );
    expect(paths(ok({ hiddenBlocks: 'product-sku' }))).toEqual([
      'hiddenBlocks',
    ]);
  });

  it('rejects oversized documents', () => {
    const big = ok({ hiddenBlocks: Array(2000).fill('product-sku') });
    expect(validate(big)).toEqual([
      { path: '', message: 'The document is too large.' },
    ]);
  });
});
