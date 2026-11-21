import { describe, expect, it } from 'vitest';
import {
  isSafeUrl,
  validateTemplateDocument,
  type ValidationContext,
} from './template-document.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ctx = (kind: ValidationContext['kind'] = 'index'): ValidationContext => ({
  kind,
  tenantId: TENANT,
});

const node = (type: string, settings: Record<string, unknown> = {}) => ({
  type,
  settings,
  blocks: {},
  block_order: [],
});

const page = (sections: Record<string, unknown>, order?: string[]) => ({
  schemaVersion: 1,
  layout: 'classic',
  sections,
  order: order ?? Object.keys(sections),
});

describe('validateTemplateDocument', () => {
  it('accepts a well-formed page', () => {
    const doc = page({
      hero: node('hero', {
        heading: 'Hello',
        accentColor: '#112233',
        image: { path: `${TENANT}/store/hero.jpg` },
      }),
      grid: node('product-grid', { columns: 4 }),
    });
    expect(validateTemplateDocument(doc, ctx())).toEqual([]);
  });

  it('rejects non-objects and the wrong schema version', () => {
    expect(validateTemplateDocument('x', ctx())).toHaveLength(1);
    expect(
      validateTemplateDocument({ ...page({}), schemaVersion: 2 }, ctx()),
    ).toEqual([expect.objectContaining({ path: 'schemaVersion' })]);
  });

  it('requires order to list every section exactly once', () => {
    const doc = page({ a: node('hero'), b: node('product-grid') }, ['a']);
    expect(validateTemplateDocument(doc, ctx())).toEqual([
      expect.objectContaining({ path: 'order' }),
    ]);
    const dup = page({ a: node('hero') }, ['a', 'a']);
    expect(validateTemplateDocument(dup, ctx())).not.toEqual([]);
  });

  it('keeps section types to the page kind', () => {
    const doc = page({ f: node('footer') });
    expect(validateTemplateDocument(doc, ctx('index'))).toEqual([
      expect.objectContaining({ path: 'sections.f.type' }),
    ]);
    expect(validateTemplateDocument(doc, ctx('group_footer'))).toEqual([]);
    expect(
      validateTemplateDocument(page({ m: node('main-product') }), ctx('index')),
    ).not.toEqual([]);
    expect(
      validateTemplateDocument(
        page({ m: node('main-product') }),
        ctx('product'),
      ),
    ).toEqual([]);
  });

  it('rejects unsafe links', () => {
    for (const link of [
      'javascript:alert(1)',
      '//evil.example',
      'https://good.example@evil.example',
      'data:text/html;base64,AA==',
    ]) {
      const doc = page({ p: node('promotional-banner', { link }) });
      expect(validateTemplateDocument(doc, ctx()), link).not.toEqual([]);
    }
    expect(
      validateTemplateDocument(
        page({ p: node('promotional-banner', { link: '/collections/new' }) }),
        ctx(),
      ),
    ).toEqual([]);
  });

  it("rejects another tenant's image and path traversal", () => {
    for (const path of [
      '22222222-2222-4222-8222-222222222222/store/a.jpg',
      `${TENANT}/store/../../x.jpg`,
      `${TENANT}/products/a.jpg`,
    ]) {
      const doc = page({ h: node('hero', { image: { path } }) });
      expect(validateTemplateDocument(doc, ctx()), path).not.toEqual([]);
    }
  });

  it('accepts platform theme assets only in their strict form', () => {
    const ok = page({
      h: node('hero', { image: { asset: 'fashion/hero.jpg' } }),
    });
    expect(validateTemplateDocument(ok, ctx())).toEqual([]);
    const bad = page({
      h: node('hero', { image: { asset: '../fashion/hero.jpg' } }),
    });
    expect(validateTemplateDocument(bad, ctx())).not.toEqual([]);
  });

  it('rejects non-hex colours', () => {
    const doc = page({ h: node('hero', { accentColor: 'red' }) });
    expect(validateTemplateDocument(doc, ctx())).not.toEqual([]);
  });

  it('limits block nesting, ids and unknown node fields', () => {
    const deep = (n: number): Record<string, unknown> =>
      n === 0
        ? node('text')
        : {
            ...node('column'),
            blocks: { [`b${n}`]: deep(n - 1) },
            block_order: [`b${n}`],
          };
    const tooDeep = page({
      s: { ...node('multicolumn'), blocks: { c: deep(3) }, block_order: ['c'] },
    });
    expect(validateTemplateDocument(tooDeep, ctx())).not.toEqual([]);
    expect(
      validateTemplateDocument(page({ 'bad id': node('hero') }), ctx()),
    ).not.toEqual([]);
    expect(
      validateTemplateDocument(
        page({ h: { ...node('hero'), extra: 1 } }),
        ctx(),
      ),
    ).not.toEqual([]);
  });

  it('rejects oversized documents', () => {
    const doc = page({
      h: node('rich-text', { content: 'x'.repeat(300_000) }),
    });
    expect(validateTemplateDocument(doc, ctx())).toEqual([
      expect.objectContaining({ message: 'The document is too large.' }),
    ]);
  });

  it('validates theme settings', () => {
    const ok = {
      schemaVersion: 1,
      settings: {
        colors: { primary: '#1a5aaa' },
        typography: { headingFont: 'manrope', baseSize: 16 },
      },
    };
    expect(validateTemplateDocument(ok, ctx('theme_settings'))).toEqual([]);
    const bad = {
      schemaVersion: 1,
      settings: { colors: { primary: 'blue' }, nope: {} },
    };
    expect(validateTemplateDocument(bad, ctx('theme_settings'))).toHaveLength(
      2,
    );
  });

  it('accepts redesigned storefront pages in the theme, per page', () => {
    const section = (type: string) => ({
      type,
      settings: {},
      blocks: {},
      block_order: [],
    });
    const page = (ids: string[]) => ({
      schemaVersion: 1,
      layout: 'classic',
      sections: Object.fromEntries(
        ids.map((id) => [id, section(id === 'cart' ? 'cart' : 'rich-text')]),
      ),
      order: ids,
    });
    const ok = {
      schemaVersion: 1,
      // Ids repeat across pages, which is fine.
      settings: {
        pages: {
          cart: page(['cart']),
          products: page(['intro', 'grid']),
          search: page(['intro', 'grid']),
        },
      },
    };
    expect(validateTemplateDocument(ok, ctx('theme_settings'))).toEqual([]);
    const unknown = {
      schemaVersion: 1,
      settings: { pages: { checkout: page(['a']) } },
    };
    expect(
      validateTemplateDocument(unknown, ctx('theme_settings')),
    ).toHaveLength(1);
    const broken = {
      schemaVersion: 1,
      settings: { pages: { cart: { ...page(['cart']), order: [] } } },
    };
    expect(
      validateTemplateDocument(broken, ctx('theme_settings')).length,
    ).toBeGreaterThan(0);
  });
});

describe('isSafeUrl', () => {
  it('allows relative, fragment, http(s) and mailto', () => {
    for (const u of [
      '/x',
      '#top',
      'https://shop.example/a?b=1',
      'mailto:hi@shop.example',
    ])
      expect(isSafeUrl(u), u).toBe(true);
  });
});
