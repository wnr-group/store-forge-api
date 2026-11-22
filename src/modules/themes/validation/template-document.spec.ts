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
      validateTemplateDocument({ ...page({}), schemaVersion: 3 }, ctx()),
    ).toEqual([expect.objectContaining({ path: 'schemaVersion' })]);
    expect(
      validateTemplateDocument({ ...page({}), schemaVersion: '2' }, ctx()),
    ).toEqual([expect.objectContaining({ path: 'schemaVersion' })]);
  });

  describe('schema 2 and display rules (QA-D-001)', () => {
    const v2 = (sections: Record<string, unknown>) => ({
      ...page(sections),
      schemaVersion: 2,
    });
    const withDisplay = (display: unknown) => ({
      ...node('hero', { heading: 'Hi' }),
      display,
    });
    const device = {
      type: 'device',
      desktop: true,
      tablet: true,
      mobile: false,
    };

    it('accepts a schema 2 page without display rules', () => {
      expect(
        validateTemplateDocument(v2({ hero: node('hero') }), ctx()),
      ).toEqual([]);
    });

    it('accepts schedule and device rules on a section and on a nested block', () => {
      const section = {
        ...withDisplay({
          v: 1,
          rules: [
            device,
            {
              type: 'schedule',
              startsAt: '2026-12-01T00:00:00Z',
              endsAt: '2026-12-05T00:00:00+05:30',
              timezone: 'Asia/Kolkata',
            },
          ],
        }),
        blocks: {
          b1: {
            ...node('button', { label: 'Go' }),
            display: { v: 1, rules: [device] },
          },
        },
        block_order: ['b1'],
      };
      expect(validateTemplateDocument(v2({ hero: section }), ctx())).toEqual(
        [],
      );
    });

    it('accepts display rules on pages stored inside the theme settings', () => {
      const theme = {
        schemaVersion: 2,
        settings: {
          pages: { cart: v2({ cart: withDisplay({ v: 1, rules: [device] }) }) },
        },
      };
      expect(validateTemplateDocument(theme, ctx('theme_settings'))).toEqual(
        [],
      );
    });

    it('rejects display rules in a schema 1 document (the exact QA-D-001 payload shape)', () => {
      const doc = page({ hero: withDisplay({ v: 1, rules: [device] }) });
      expect(validateTemplateDocument(doc, ctx())).toEqual([
        expect.objectContaining({
          path: 'sections.hero.display',
          message: 'Display rules need schema version 2.',
        }),
      ]);
    });

    it.each([
      ['not an object', 'x'],
      ['wrong version', { v: 2, rules: [] }],
      ['unknown field', { v: 1, rules: [], css: 'x' }],
      ['rules not a list', { v: 1, rules: {} }],
      ['unknown rule type', { v: 1, rules: [{ type: 'login' }] }],
      [
        'two schedules',
        {
          v: 1,
          rules: [
            { type: 'schedule', endsAt: '2026-12-01T00:00:00Z' },
            { type: 'schedule', endsAt: '2026-12-02T00:00:00Z' },
          ],
        },
      ],
      ['two device rules', { v: 1, rules: [device, device] }],
      ['too many rules', { v: 1, rules: [device, device, device] }],
      ['empty schedule', { v: 1, rules: [{ type: 'schedule' }] }],
      [
        'instant without offset',
        { v: 1, rules: [{ type: 'schedule', endsAt: '2026-12-01T00:00:00' }] },
      ],
      ['not a date', { v: 1, rules: [{ type: 'schedule', endsAt: 'soon' }] }],
      [
        'end before start',
        {
          v: 1,
          rules: [
            {
              type: 'schedule',
              startsAt: '2026-12-02T00:00:00Z',
              endsAt: '2026-12-01T00:00:00Z',
            },
          ],
        },
      ],
      [
        'unknown timezone',
        {
          v: 1,
          rules: [
            {
              type: 'schedule',
              endsAt: '2026-12-01T00:00:00Z',
              timezone: 'Mars/Base',
            },
          ],
        },
      ],
      [
        'device flag not boolean',
        {
          v: 1,
          rules: [
            { type: 'device', desktop: 'yes', tablet: true, mobile: true },
          ],
        },
      ],
      ['device rule extra field', { v: 1, rules: [{ ...device, css: 'x' }] }],
    ])('rejects malformed display rules: %s', (_name, display) => {
      const issues = validateTemplateDocument(
        v2({ hero: withDisplay(display) }),
        ctx(),
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.path === 'sections.hero.display')).toBe(
        true,
      );
    });

    it('still rejects unknown node fields', () => {
      const doc = v2({ hero: { ...node('hero'), css: 'x' } });
      expect(validateTemplateDocument(doc, ctx())).toEqual([
        expect.objectContaining({
          path: 'sections.hero',
          message: 'Unknown fields: css.',
        }),
      ]);
    });
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
