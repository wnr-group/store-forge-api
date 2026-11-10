import { describe, expect, it } from 'vitest';
import { collectImagePaths } from './image-paths.js';

describe('image-paths (D41)', () => {
  it('AC-LIFE-016: extracts path strings from image-shaped objects anywhere in the document', () => {
    const doc = {
      sections: {
        hero: {
          settings: {
            banner: { path: 'tenant-1/store/hero.jpg', alt: 'Hero' },
            title: 'Welcome',
          },
          blocks: {
            card: {
              settings: {
                thumbnail: { path: 'tenant-1/store/card.png' },
              },
            },
          },
        },
      },
    };

    const paths = collectImagePaths(doc);
    expect(paths).toHaveLength(2);
    expect(paths).toContain('tenant-1/store/hero.jpg');
    expect(paths).toContain('tenant-1/store/card.png');
  });

  it('AC-LIFE-016: traverses arrays of objects and nested structures', () => {
    const data = {
      gallery: [
        { path: 'tenant-1/store/img1.jpg' },
        { path: 'tenant-1/store/img2.jpg' },
        'just a string',
        42,
        null,
      ],
      nested: {
        deeper: [
          {
            evenDeeper: { path: 'tenant-1/store/img3.webp' },
          },
        ],
      },
    };

    const paths = collectImagePaths(data);
    expect(paths).toHaveLength(3);
    expect(paths).toContain('tenant-1/store/img1.jpg');
    expect(paths).toContain('tenant-1/store/img2.jpg');
    expect(paths).toContain('tenant-1/store/img3.webp');
  });

  it('AC-LIFE-016: de-duplicates identical image paths', () => {
    const doc = {
      primary: { path: 'tenant-1/store/logo.png' },
      secondary: { path: 'tenant-1/store/logo.png' },
      list: [{ path: 'tenant-1/store/logo.png' }],
    };

    const paths = collectImagePaths(doc);
    expect(paths).toEqual(['tenant-1/store/logo.png']);
  });

  it('AC-LIFE-016: ignores objects where path is not a string', () => {
    const doc = {
      invalid1: { path: 123 },
      invalid2: { path: null },
      invalid3: { path: true },
      invalid4: { path: { nested: 'string' } },
      invalid5: { path: ['array'] },
      valid: { path: 'tenant-1/store/valid.png' },
    };

    const paths = collectImagePaths(doc);
    expect(paths).toEqual(['tenant-1/store/valid.png']);
  });

  it('AC-LIFE-016: handles primitives, null, and empty inputs gracefully', () => {
    expect(collectImagePaths(null)).toEqual([]);
    expect(collectImagePaths(undefined)).toEqual([]);
    expect(collectImagePaths('string')).toEqual([]);
    expect(collectImagePaths(12345)).toEqual([]);
    expect(collectImagePaths(true)).toEqual([]);
    expect(collectImagePaths({})).toEqual([]);
    expect(collectImagePaths([])).toEqual([]);
  });

  it('AC-LIFE-016: iterative walk survives 5,000-deep nesting without call stack overflow', () => {
    type DeepObj = { next?: DeepObj; path?: string };
    const root: DeepObj = {};
    let current = root;
    for (let i = 0; i < 5000; i++) {
      current.next = {};
      current = current.next;
    }
    current.path = 'tenant-1/store/deep.jpg';

    const paths = collectImagePaths(root);
    expect(paths).toEqual(['tenant-1/store/deep.jpg']);
  });
});
