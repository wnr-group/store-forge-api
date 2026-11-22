import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastLevel, contrastRatio } from './contrast.js';
import { analyzeDisplay, parseInstant } from './display.js';
import { evaluateReadiness, unacknowledgedWarnings } from './engine.js';
import { loadManifests, MANIFEST_BUNDLE } from './manifests.js';
import { READINESS_RULES } from './rules.js';
import type { ReadinessContext, ReadinessManifest } from './types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-06-15T12:00:00Z');

const block = (
  type: string,
  settings: Record<string, unknown> = {},
  extra = {},
) => ({
  type,
  settings,
  blocks: {},
  block_order: [],
  ...extra,
});
const section = (
  type: string,
  settings: Record<string, unknown> = {},
  blocks: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  type,
  settings,
  blocks,
  block_order: Object.keys(blocks),
  ...extra,
});
const page = (sections: Record<string, unknown>) => ({
  schemaVersion: 1,
  layout: 'classic',
  sections,
  order: Object.keys(sections),
});

const ctxOf = (
  document: unknown,
  over: Partial<ReadinessContext> = {},
): ReadinessContext => ({
  tenantId: TENANT,
  storeId: '33333333-3333-4333-8333-333333333333',
  store: { timezone: 'Asia/Kolkata', currency: 'INR' },
  documents: [{ id: DOC, kind: 'index', name: 'Home', document }],
  manifests: loadManifests(),
  now: NOW,
  availability: {},
  purchaseFlowLive: false,
  actor: { userId: '44444444-4444-4444-8444-444444444444' },
  ...over,
});

const idsOf = (document: unknown, over: Partial<ReadinessContext> = {}) =>
  evaluateReadiness(ctxOf(document, over)).issues.map((i) => i.ruleId);

const withNode = (node: Record<string, unknown>) =>
  page({ s1: section('rich-text', {}, {}, node) });

const clean = page({ s1: section('rich-text', { heading: 'Hello' }) });

describe('registry', () => {
  it('registers every release-1 rule once, with a severity, message key, fix action and control path', () => {
    const ids = READINESS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        'a11y.contrast.below-3',
        'a11y.contrast.below-4.5',
        'a11y.contrast.unknown',
        'a11y.name.empty',
        'badge.excluded-claim',
        'component.deprecated',
        'component.unavailable',
        'display.device.none',
        'display.schedule.all-expired',
        'display.schedule.invalid',
        'display.schedule.order',
        'doc.invalid-config',
        'doc.limits.exceeded',
        'media.alt.missing',
      ].sort(),
    );
    const sev = Object.fromEntries(
      READINESS_RULES.map((r) => [r.id, r.severity]),
    );
    expect(sev).toMatchObject({
      'display.schedule.invalid': 'BLOCKER',
      'display.schedule.order': 'BLOCKER',
      'display.schedule.all-expired': 'WARNING',
      'display.device.none': 'WARNING',
      'component.unavailable': 'BLOCKER',
      'component.deprecated': 'WARNING',
      'media.alt.missing': 'BLOCKER',
      'a11y.name.empty': 'BLOCKER',
      'a11y.contrast.below-3': 'BLOCKER',
      'a11y.contrast.below-4.5': 'WARNING',
      'a11y.contrast.unknown': 'WARNING',
      'doc.invalid-config': 'BLOCKER',
      'doc.limits.exceeded': 'BLOCKER',
    });
    for (const r of READINESS_RULES) {
      expect(r.messageKey).toMatch(/^readiness\./);
      expect(r.fixAction).not.toBe('');
      expect(r.controlPath).not.toBe('');
    }
  });

  it('a clean document has no issues', () => {
    const r = evaluateReadiness(ctxOf(clean));
    expect(r.issues).toEqual([]);
    expect(r.counts).toEqual({ blockers: 0, warnings: 0, information: 0 });
    expect(r.canPublish).toBe(true);
  });
});

describe('display rules', () => {
  const sched = (s: Record<string, unknown>) => ({
    v: 1,
    rules: [{ type: 'schedule', ...s }],
  });

  it('parseInstant needs an offset and a real calendar date', () => {
    expect(parseInstant('2026-12-01T09:00:00Z')).not.toBeNull();
    expect(parseInstant('2026-12-01T09:00+05:30')).not.toBeNull();
    expect(parseInstant('2026-12-01T09:00:00')).toBeNull();
    expect(parseInstant('2026-02-30T09:00:00Z')).toBeNull();
    expect(parseInstant('tomorrow')).toBeNull();
    expect(parseInstant(5)).toBeNull();
  });

  it('display.schedule.invalid: fails for bad instants, unknown zone, empty schedule, two schedules, bad shape; passes for a good one', () => {
    const bad = [
      sched({ startsAt: '2026-12-01' }),
      sched({ endsAt: 'soon' }),
      sched({}),
      sched({ startsAt: '2026-12-01T00:00:00Z', timezone: 'Mars/Base' }),
      {
        v: 1,
        rules: [
          { type: 'schedule', startsAt: '2027-01-01T00:00:00Z' },
          { type: 'schedule', endsAt: '2027-02-01T00:00:00Z' },
        ],
      },
      { v: 2, rules: [] },
      { v: 1, rules: 'x' },
      'always',
    ];
    for (const display of bad)
      expect(idsOf(withNode({ display }))).toContain(
        'display.schedule.invalid',
      );
    const good = sched({
      startsAt: '2027-01-01T00:00:00Z',
      endsAt: '2027-02-01T00:00:00Z',
      timezone: 'Asia/Kolkata',
    });
    expect(idsOf(withNode({ display: good }))).not.toContain(
      'display.schedule.invalid',
    );
    expect(idsOf(withNode({}))).not.toContain('display.schedule.invalid');
  });

  it('allows at most one device rule', () => {
    const d = { type: 'device', desktop: true, tablet: true, mobile: true };
    expect(idsOf(withNode({ display: { v: 1, rules: [d, d] } }))).toContain(
      'display.schedule.invalid',
    );
    expect(idsOf(withNode({ display: { v: 1, rules: [d] } }))).not.toContain(
      'display.schedule.invalid',
    );
  });

  it('display.schedule.order: end equal to or before start fails, end after start passes', () => {
    const at = '2027-01-01T00:00:00Z';
    expect(
      idsOf(withNode({ display: sched({ startsAt: at, endsAt: at }) })),
    ).toContain('display.schedule.order');
    expect(
      idsOf(
        withNode({
          display: sched({ startsAt: at, endsAt: '2026-12-31T00:00:00Z' }),
        }),
      ),
    ).toContain('display.schedule.order');
    // Offsets are compared as instants: 05:30+05:30 is exactly 00:00Z.
    expect(
      idsOf(
        withNode({
          display: sched({
            startsAt: '2027-01-01T00:00:00Z',
            endsAt: '2027-01-01T05:30:00+05:30',
          }),
        }),
      ),
    ).toContain('display.schedule.order');
    expect(
      idsOf(
        withNode({
          display: sched({ startsAt: at, endsAt: '2027-01-02T00:00:00Z' }),
        }),
      ),
    ).not.toContain('display.schedule.order');
    // A schedule with only one end has no order to check.
    expect(idsOf(withNode({ display: sched({ startsAt: at }) }))).not.toContain(
      'display.schedule.order',
    );
  });

  it('display.schedule.all-expired: warns when the end has passed on the server clock, not before', () => {
    const past = sched({
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-06-01T00:00:00Z',
    });
    const future = sched({
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-12-01T00:00:00Z',
    });
    const exact = sched({
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: NOW.toISOString(),
    });
    expect(idsOf(withNode({ display: past }))).toContain(
      'display.schedule.all-expired',
    );
    expect(idsOf(withNode({ display: exact }))).toContain(
      'display.schedule.all-expired',
    );
    expect(idsOf(withNode({ display: future }))).not.toContain(
      'display.schedule.all-expired',
    );
    expect(
      idsOf(withNode({ display: sched({ startsAt: '2026-01-01T00:00:00Z' }) })),
    ).not.toContain('display.schedule.all-expired');
  });

  it('display.device.none: warns when every device is off, not when one is on', () => {
    const rule = (d: boolean, t: boolean, m: boolean) => ({
      v: 1,
      rules: [{ type: 'device', desktop: d, tablet: t, mobile: m }],
    });
    expect(idsOf(withNode({ display: rule(false, false, false) }))).toContain(
      'display.device.none',
    );
    expect(
      idsOf(withNode({ display: rule(false, false, true) })),
    ).not.toContain('display.device.none');
  });

  it('analyzeDisplay never throws on hostile input', () => {
    for (const v of [
      null,
      1,
      [],
      { rules: [null, 1, 'x'] },
      { v: 1, rules: [{ type: 'schedule', startsAt: {} }] },
    ])
      expect(() => analyzeDisplay(v)).not.toThrow();
  });
});

describe('components', () => {
  const manifests = (m: Partial<ReadinessManifest>) =>
    new Map<string, ReadinessManifest>([
      [
        'block:badge',
        {
          kind: 'block',
          id: 'badge',
          availability: 'available',
          requiresPurchaseFlow: false,
          legal: { required: false },
          ...m,
        },
      ],
    ]);
  const doc = page({ s1: section('rich-text', {}, { b1: block('badge') }) });

  it('component.unavailable: blocks an unavailable manifest, passes an available one', () => {
    expect(
      idsOf(doc, { manifests: manifests({ availability: 'unavailable' }) }),
    ).toContain('component.unavailable');
    expect(idsOf(doc, { manifests: manifests({}) })).not.toContain(
      'component.unavailable',
    );
  });

  it('component.unavailable: legal gate comes from feature availability; purchase flow from the context', () => {
    const legal = manifests({
      legal: { required: true, featureKey: 'badge_upload' },
    });
    expect(idsOf(doc, { manifests: legal, availability: {} })).toContain(
      'component.unavailable',
    );
    expect(
      idsOf(doc, {
        manifests: legal,
        availability: { badge_upload: 'unavailable' },
      }),
    ).toContain('component.unavailable');
    expect(
      idsOf(doc, {
        manifests: legal,
        availability: { badge_upload: 'available' },
      }),
    ).not.toContain('component.unavailable');
    const flow = manifests({ requiresPurchaseFlow: true });
    expect(idsOf(doc, { manifests: flow, purchaseFlowLive: false })).toContain(
      'component.unavailable',
    );
    expect(
      idsOf(doc, { manifests: flow, purchaseFlowLive: true }),
    ).not.toContain('component.unavailable');
  });

  it('component.unavailable ignores disabled nodes; unknown types are not its concern', () => {
    const off = page({
      s1: section(
        'rich-text',
        {},
        { b1: block('badge', {}, { disabled: true }) },
      ),
    });
    expect(
      idsOf(off, { manifests: manifests({ availability: 'unavailable' }) }),
    ).not.toContain('component.unavailable');
    const unknown = page({
      s1: section('rich-text', {}, { b1: block('nope') }),
    });
    expect(idsOf(unknown)).not.toContain('component.unavailable');
  });

  it('component.deprecated: warns for deprecated, not for available', () => {
    expect(
      idsOf(doc, { manifests: manifests({ availability: 'deprecated' }) }),
    ).toContain('component.deprecated');
    expect(idsOf(doc, { manifests: manifests({}) })).not.toContain(
      'component.deprecated',
    );
  });

  it('the real bundle has every section type the API validator accepts as available', () => {
    const m = loadManifests();
    for (const type of [
      'hero',
      'rich-text',
      'product-grid',
      'header',
      'footer',
    ])
      expect(m.get(`section:${type}`)?.availability).toBe('available');
  });
});

describe('media and names', () => {
  const img = (alt?: string) => ({
    path: `${TENANT}/store/a.jpg`,
    ...(alt === undefined ? {} : { alt }),
  });
  const imageDoc = (settings: Record<string, unknown>) =>
    page({ s1: section('rich-text', {}, { i1: block('image', settings) }) });

  it('media.alt.missing: fails without alt, passes with alt, passes when decorative, ignores an empty image setting', () => {
    expect(idsOf(imageDoc({ image: img() }))).toContain('media.alt.missing');
    expect(idsOf(imageDoc({ image: img('   ') }))).toContain(
      'media.alt.missing',
    );
    expect(idsOf(imageDoc({ image: img('A red shirt') }))).not.toContain(
      'media.alt.missing',
    );
    expect(idsOf(imageDoc({ image: img(), decorative: true }))).not.toContain(
      'media.alt.missing',
    );
    expect(idsOf(imageDoc({ image: null }))).not.toContain('media.alt.missing');
    expect(idsOf(imageDoc({ image: { asset: 'atelier/hero.jpg' } }))).toContain(
      'media.alt.missing',
    );
  });

  const named = (type: string, settings: Record<string, unknown>) =>
    page({ s1: section('rich-text', {}, { b1: block(type, settings) }) });

  it('a11y.name.empty: fails for blank link, button and social-link labels; passes with a label', () => {
    expect(idsOf(named('link', { label: '  ', url: '/' }))).toContain(
      'a11y.name.empty',
    );
    expect(idsOf(named('button', { label: '', link: '/' }))).toContain(
      'a11y.name.empty',
    );
    expect(idsOf(named('social-link', { label: '', network: 'x' }))).toContain(
      'a11y.name.empty',
    );
    expect(
      idsOf(named('social-link', { network: '', url: 'https://x.com' })),
    ).toContain('a11y.name.empty');
    expect(idsOf(named('link', { label: 'Shop', url: '/' }))).not.toContain(
      'a11y.name.empty',
    );
    expect(idsOf(named('button', { label: 'Buy' }))).not.toContain(
      'a11y.name.empty',
    );
    expect(idsOf(named('social-link', { network: 'x' }))).not.toContain(
      'a11y.name.empty',
    );
    expect(
      idsOf(named('social-link', { label: 'Follow us on X', network: 'x' })),
    ).not.toContain('a11y.name.empty');
    expect(idsOf(named('heading', { text: '' }))).not.toContain(
      'a11y.name.empty',
    );
  });
});

describe('contrast', () => {
  const colours = (color?: string, backgroundColor?: string) =>
    page({
      s1: section('rich-text', {
        _style: {
          base: {
            ...(color ? { color } : {}),
            ...(backgroundColor ? { backgroundColor } : {}),
          },
        },
      }),
    });

  it('level boundaries: 2.9 blocks, 3.0 is not a blocker (still a warning), 4.4 warns, 4.5 passes', () => {
    expect(contrastLevel(2.9)).toBe('below-3');
    expect(contrastLevel(2.999)).toBe('below-3');
    expect(contrastLevel(3.0)).toBe('below-4.5');
    expect(contrastLevel(4.4)).toBe('below-4.5');
    expect(contrastLevel(4.499)).toBe('below-4.5');
    expect(contrastLevel(4.5)).toBe('ok');
    expect(contrastLevel(21)).toBe('ok');
  });

  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#959595', '#ffffff')).toBeLessThan(3);
    expect(contrastRatio('#949494', '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('below-3 blocks (2.99:1), and does not also warn at 4.5', () => {
    const ids = idsOf(colours('#959595', '#ffffff'));
    expect(ids).toContain('a11y.contrast.below-3');
    expect(ids).not.toContain('a11y.contrast.below-4.5');
    expect(ids).not.toContain('a11y.contrast.unknown');
  });

  it('3.03:1 is not a blocker but warns below 4.5; 4.48:1 warns; 4.54:1 passes', () => {
    const at3 = idsOf(colours('#949494', '#ffffff'));
    expect(at3).not.toContain('a11y.contrast.below-3');
    expect(at3).toContain('a11y.contrast.below-4.5');
    expect(idsOf(colours('#777777', '#ffffff'))).toContain(
      'a11y.contrast.below-4.5',
    );
    expect(idsOf(colours('#767676', '#ffffff'))).toEqual([]);
    expect(idsOf(colours('#000000', '#ffffff'))).toEqual([]);
  });

  it('unknown: one colour only, or a missing background, is a warning that needs manual review, never a pass', () => {
    for (const doc of [colours('#000000'), colours(undefined, '#ffffff')]) {
      const r = evaluateReadiness(ctxOf(doc));
      expect(r.issues.map((i) => i.ruleId)).toEqual(['a11y.contrast.unknown']);
      expect(r.issues[0].severity).toBe('WARNING');
      expect(r.issues[0].message).toContain('manual review');
    }
  });

  it('nothing is reported for a node that sets no colours at all, and settings colours are read too', () => {
    expect(idsOf(clean)).toEqual([]);
    const plain = page({
      s1: section('rich-text', {
        textColor: '#959595',
        backgroundColor: '#ffffff',
      }),
    });
    expect(idsOf(plain)).toContain('a11y.contrast.below-3');
  });
});

describe('document rules', () => {
  it('doc.invalid-config: fails for a document the validator rejects, passes for a valid one', () => {
    expect(idsOf({ ...clean, layout: 'fancy' })).toContain(
      'doc.invalid-config',
    );
    expect(idsOf('nope')).toContain('doc.invalid-config');
    expect(idsOf(clean)).not.toContain('doc.invalid-config');
  });

  it('doc.invalid-config points at the node the validator path names', () => {
    const bad = page({
      s1: section('rich-text', { link: 'javascript:alert(1)' }),
    });
    const issue = evaluateReadiness(ctxOf(bad)).issues.find(
      (i) => i.ruleId === 'doc.invalid-config',
    );
    expect(issue?.target).toEqual({ documentId: DOC, nodeId: 's1' });
  });

  it('doc.limits.exceeded: fails over the section limit and the size limit, passes under them', () => {
    const many = page(
      Object.fromEntries(
        Array.from({ length: 26 }, (_, i) => [`s${i}`, section('rich-text')]),
      ),
    );
    expect(idsOf(many)).toContain('doc.limits.exceeded');
    const big = page({
      s1: section(
        'rich-text',
        { a: 'x'.repeat(5000), b: 'x'.repeat(5000) },
        {},
        { pad: 'x'.repeat(260_000) },
      ),
    });
    expect(idsOf(big)).toContain('doc.limits.exceeded');
    expect(idsOf(clean)).not.toContain('doc.limits.exceeded');
    // A limit is not also reported as a configuration mistake.
    expect(idsOf(many)).not.toContain('doc.invalid-config');
  });

  it('badge.excluded-claim is registered and reports nothing yet', () => {
    expect(
      READINESS_RULES.find((r) => r.id === 'badge.excluded-claim')?.evaluate(
        ctxOf(clean),
      ),
    ).toEqual([]);
  });
});

describe('engine', () => {
  it('orders blockers, then warnings, then information, and counts them', () => {
    const doc = page({
      s1: section('rich-text', { _style: { base: { color: '#000000' } } }),
      s2: section(
        'rich-text',
        {},
        { i: block('image', { image: { path: `${TENANT}/store/a.jpg` } }) },
      ),
    });
    const r = evaluateReadiness(ctxOf(doc));
    expect(r.issues.map((i) => i.severity)).toEqual(['BLOCKER', 'WARNING']);
    expect(r.counts).toEqual({ blockers: 1, warnings: 1, information: 0 });
    expect(r.canPublish).toBe(false);
    expect(r.issues[0]).toMatchObject({
      ruleId: 'media.alt.missing',
      target: { documentId: DOC, nodeId: 'i' },
      fixAction: 'add_alt_text',
      controlPath: 'settings.image.alt',
    });
  });

  it('issue keys are unique and stable between runs', () => {
    const doc = page({
      s1: section('rich-text', { _style: { base: { color: '#000000' } } }),
    });
    const a = evaluateReadiness(ctxOf(doc)).issues.map((i) => i.key);
    const b = evaluateReadiness(ctxOf(doc)).issues.map((i) => i.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('a rule that throws becomes a blocker', () => {
    const r = evaluateReadiness(ctxOf(clean), [
      {
        ...READINESS_RULES[0],
        severity: 'WARNING',
        evaluate: () => {
          throw new Error('boom');
        },
      },
    ]);
    expect(r.counts.blockers).toBe(1);
  });

  it('unacknowledgedWarnings lists only warnings not named; blockers are never acknowledgeable', () => {
    const doc = page({
      s1: section('rich-text', { _style: { base: { color: '#000000' } } }),
      s2: section(
        'rich-text',
        {},
        { i: block('image', { image: { path: `${TENANT}/store/a.jpg` } }) },
      ),
    });
    const r = evaluateReadiness(ctxOf(doc));
    const warning = r.issues.find((i) => i.severity === 'WARNING')!;
    const blocker = r.issues.find((i) => i.severity === 'BLOCKER')!;
    expect(unacknowledgedWarnings(r, [])).toHaveLength(1);
    expect(unacknowledgedWarnings(r, [warning.key])).toHaveLength(0);
    // Naming a blocker does not clear anything: it is not a warning, and the report still has it.
    expect(unacknowledgedWarnings(r, [blocker.key])).toHaveLength(1);
    expect(r.counts.blockers).toBe(1);
  });
});

describe('manifest bundle', () => {
  it('has the generated shape', () => {
    expect(MANIFEST_BUNDLE.bundleVersion).toBe(1);
    expect(MANIFEST_BUNDLE.manifests.length).toBeGreaterThan(0);
    expect(loadManifests().size).toBe(MANIFEST_BUNDLE.manifests.length);
  });

  const sibling = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../../../store-forge-integ/lib/templates/manifest-bundle.generated.json',
  );
  it.skipIf(!existsSync(sibling))(
    'is identical to the frontend copy (drift test)',
    () => {
      const fe = JSON.parse(readFileSync(sibling, 'utf8'));
      expect(MANIFEST_BUNDLE).toEqual(fe);
    },
  );
  if (!existsSync(sibling))
    it('drift test skipped: the sibling frontend repo (store-forge-integ) was not found next to this repo, so the manifest bundle was not compared', () => {
      expect(true).toBe(true);
    });
});
