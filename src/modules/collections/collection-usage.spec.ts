import { describe, expect, it } from 'vitest';
import {
  computeUsage,
  findCollectionRefs,
  type TemplateSource,
} from './collection-usage.js';

const target = { id: '11111111-1111-4111-8111-111111111111', slug: 'summer' };
const section = (
  collectionId: unknown,
  extra: Record<string, unknown> = {},
) => ({
  type: 'featured-collection',
  settings: { collectionId, ...extra },
  blocks: {},
  block_order: [],
});
const page = (...entries: [string, unknown][]) => ({
  schemaVersion: 1,
  order: entries.map(([k]) => k),
  sections: Object.fromEntries(entries),
});
const tpl = (over: Partial<TemplateSource> = {}): TemplateSource => ({
  id: 't1',
  name: 'Home',
  kind: 'index',
  draft: page(),
  published: null,
  ...over,
});

describe('findCollectionRefs', () => {
  it('matches by id and by slug, trimmed', () => {
    const doc = page(
      ['a', section(target.id)],
      ['b', section(' summer ')],
      ['c', section('winter')],
    );
    expect(findCollectionRefs(doc, target).map((r) => r.sectionId)).toEqual([
      'a',
      'b',
    ]);
  });
  it('ignores other section types and URLs or free text that mention the collection', () => {
    const doc = page(
      [
        'hero',
        {
          type: 'hero',
          settings: { collectionId: target.id, link: '/collections/summer' },
          blocks: {},
          block_order: [],
        },
      ],
      ['f', section('', { title: '/collections/summer', eyebrow: target.id })],
    );
    expect(findCollectionRefs(doc, target)).toEqual([]);
  });
  it('finds sections inside theme-settings virtual pages and reports the path', () => {
    const theme = {
      settings: { pages: { cart: page(['x', section(target.slug)]) } },
    };
    expect(findCollectionRefs(theme, target)).toEqual([
      { sectionId: 'x', path: 'settings.pages.cart.sections.x' },
    ]);
  });
  it('counts a disabled section, tolerates junk and stops at depth 64', () => {
    expect(
      findCollectionRefs(
        page(['d', { ...section(target.id), disabled: true }]),
        target,
      ),
    ).toHaveLength(1);
    expect(findCollectionRefs(null, target)).toEqual([]);
    expect(findCollectionRefs([1, 'x', { type: 5 }], target)).toEqual([]);
    let deep: Record<string, unknown> = section(target.id);
    for (let i = 0; i < 80; i++) deep = { child: deep };
    expect(findCollectionRefs(deep, target)).toEqual([]);
  });
});

describe('computeUsage', () => {
  it('merges the same section in draft and published into one reference', () => {
    const doc = page(['f', section(target.id)]);
    const u = computeUsage([tpl({ draft: doc, published: doc })], target);
    expect(u.total).toBe(1);
    expect(u.references[0]).toMatchObject({
      templateId: 't1',
      kind: 'index',
      location: 'index',
      sectionId: 'f',
      inDraft: true,
      inPublished: true,
    });
  });
  it('separates draft-only and labels virtual pages', () => {
    const u = computeUsage(
      [
        tpl({ draft: page(['f', section(target.id)]) }),
        tpl({
          id: 't2',
          name: 'Theme',
          kind: 'theme_settings',
          draft: {
            settings: { pages: { search: page(['y', section('summer')]) } },
          },
        }),
      ],
      target,
    );
    expect(u.total).toBe(2);
    expect(u.references.find((r) => r.templateId === 't1')).toMatchObject({
      inDraft: true,
      inPublished: false,
    });
    expect(u.references.find((r) => r.templateId === 't2')?.location).toBe(
      'search page',
    );
  });
  it('has a stable hash that changes with the set of references', () => {
    const one = computeUsage(
      [tpl({ draft: page(['f', section(target.id)]) })],
      target,
    );
    const same = computeUsage(
      [tpl({ draft: page(['f', section('summer')]) })],
      target,
    );
    const two = computeUsage(
      [
        tpl({
          draft: page(['f', section(target.id)], ['g', section(target.id)]),
        }),
      ],
      target,
    );
    const live = computeUsage(
      [
        tpl({
          draft: page(['f', section(target.id)]),
          published: page(['f', section(target.id)]),
        }),
      ],
      target,
    );
    expect(one.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(same.hash).toBe(one.hash);
    expect(two.hash).not.toBe(one.hash);
    expect(live.hash).not.toBe(one.hash);
    expect(computeUsage([tpl()], target)).toMatchObject({
      total: 0,
      references: [],
    });
  });
});
