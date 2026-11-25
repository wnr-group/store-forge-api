import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaPixelProvider } from './meta-pixel.provider.js';
import { findProvider } from './provider-registry.js';

const meta = new MetaPixelProvider();

afterEach(() => vi.unstubAllGlobals());

describe('Meta Pixel configuration', () => {
  it('accepts a 15 or 16 digit Pixel ID, forgiving spaces and dashes from a paste', () => {
    expect(meta.parse({ pixelId: '123456789012345' })).toEqual({
      ok: true,
      config: { pixelId: '123456789012345' },
    });
    expect(meta.parse({ pixelId: ' 1234 5678 9012 3456 ' })).toEqual({
      ok: true,
      config: { pixelId: '1234567890123456' },
    });
    expect(meta.parse({ pixelId: '12345-67890-12345' })).toEqual({
      ok: true,
      config: { pixelId: '123456789012345' },
    });
  });

  it.each([
    ['', 'empty'],
    ['12345678901234', '14 digits'],
    ['12345678901234567', '17 digits'],
    ['1234567890abcde', 'letters'],
    ['G-ABCDE12345', 'a GA4 ID'],
    ['act_123456789012345', 'an ad account ID'],
    ['123456789012345; alert(1)', 'script'],
    ['１２３４５６７８９０１２３４５', 'full-width digits'],
  ])('refuses %j (%s)', (value) => {
    const r = meta.parse({ pixelId: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['pixelId']);
  });

  it('refuses a missing value, a non-text value and settings it does not have', () => {
    expect(meta.parse({}).ok).toBe(false);
    expect(meta.parse({ pixelId: 123456789012345 }).ok).toBe(false);
    const extra = meta.parse({ pixelId: '123456789012345', accessToken: 'x' });
    expect(extra.ok).toBe(false);
    if (!extra.ok)
      expect(extra.errors).toEqual({
        accessToken: 'This setting does not exist.',
      });
  });
});

describe('Meta Pixel test', () => {
  const run = () => meta.test({ pixelId: '123456789012345' });

  it("passes when Meta's script loads, asking only Meta's script host and sending nothing to the Pixel", async () => {
    const fetchMock = vi.fn(
      async () => new Response('!function(f,b){window.fbq=1}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const checks = await run();
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toBe('https://connect.facebook.net/en_US/fbevents.js');
    expect(url).not.toContain('123456789012345');
  });

  it('fails when the script cannot be loaded, and says so without blaming the ID when Meta is unreachable', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    expect((await run()).find((c) => c.name === 'Meta script')?.ok).toBe(false);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const tag = (await run()).find((c) => c.name === 'Meta script');
    expect(tag?.ok).toBe(false);
    expect(tag?.message).toMatch(/does not mean the ID is wrong/);
  });

  it('never contacts anyone for an ID that is not well formed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const checks = await meta.test({ pixelId: 'https://evil.example' });
    expect(checks).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('registered next to Google Analytics', () => {
  it('is found by its code, with a note that sends nothing to the Pixel', () => {
    const p = findProvider('meta_pixel');
    expect(p?.name).toBe('Meta Pixel');
    expect(p?.testNote).toMatch(/sends nothing to your Pixel/);
  });
});
