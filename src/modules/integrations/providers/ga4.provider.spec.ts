import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ga4Provider } from './ga4.provider.js';
import { findProvider, listProviders } from './provider-registry.js';

const ga4 = new Ga4Provider();

afterEach(() => vi.unstubAllGlobals());

describe('GA4 configuration', () => {
  it('accepts a Measurement ID and normalizes its case and spacing', () => {
    expect(ga4.parse({ measurementId: ' g-abcde12345 ' })).toEqual({
      ok: true,
      config: { measurementId: 'G-ABCDE12345' },
    });
  });

  it.each([
    ['', 'empty'],
    ['G-SHORT', 'too short'],
    ['G-ABCDE123456', 'too long'],
    ['UA-12345678-1', 'Universal Analytics'],
    ['AW-1234567890', 'Google Ads'],
    ['G-ABCDE1234!', 'symbol'],
    ['G-ABCDE12345\n<script>', 'markup'],
    ['GTM-ABCDEF1', 'Tag Manager'],
  ])('refuses %j (%s)', (value) => {
    const r = ga4.parse({ measurementId: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['measurementId']);
  });

  it('refuses a missing value, a non-text value and settings it does not have', () => {
    expect(ga4.parse({}).ok).toBe(false);
    expect(ga4.parse({ measurementId: 12345 }).ok).toBe(false);
    const extra = ga4.parse({ measurementId: 'G-ABCDE12345', apiSecret: 'x' });
    expect(extra.ok).toBe(false);
    if (!extra.ok)
      expect(extra.errors).toEqual({
        apiSecret: 'This setting does not exist.',
      });
  });
});

describe('GA4 test', () => {
  const run = () => ga4.test({ measurementId: 'G-ABCDE12345' });

  it("passes when Google serves its tag for the ID, asking only Google's tag host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('window.dataLayer; "G-ABCDE12345"', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const checks = await run();
    expect(checks.every((c) => c.ok)).toBe(true);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe(
      'https://www.googletagmanager.com/gtag/js?id=G-ABCDE12345',
    );
  });

  it('fails when Google does not serve the tag, or serves something without the ID', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    expect((await run()).find((c) => c.name === 'Google tag')?.ok).toBe(false);
    vi.stubGlobal(
      'fetch',
      async () => new Response('// empty', { status: 200 }),
    );
    expect((await run()).find((c) => c.name === 'Google tag')?.ok).toBe(false);
  });

  it('reports an unreachable Google without throwing, and without blaming the ID', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const checks = await run();
    const tag = checks.find((c) => c.name === 'Google tag');
    expect(tag?.ok).toBe(false);
    expect(tag?.message).toMatch(/does not mean the ID is wrong/);
  });

  it('never contacts anyone for an ID that is not well formed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const checks = await ga4.test({ measurementId: 'https://evil.example/x' });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider registry', () => {
  it('lists the providers and finds one by code', () => {
    expect(listProviders().map((p) => p.code)).toContain('ga4');
    expect(findProvider('ga4')?.name).toBe('Google Analytics 4');
    expect(findProvider('nope')).toBeUndefined();
    for (const p of listProviders())
      expect(p.code).toMatch(/^[a-z][a-z0-9_]{1,30}$/);
  });
});
