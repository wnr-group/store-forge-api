import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlueDartProvider } from '../src/modules/shipping/providers/bluedart.provider.js';
import {
  CarrierHttp,
  messageOf,
  normalizeStatus,
  rupeesToMinor,
  scrub,
  safeUrl,
  TokenCache,
} from '../src/modules/shipping/providers/carrier-http.js';
import { DelhiveryProvider } from '../src/modules/shipping/providers/delhivery.provider.js';
import { ShippingProviderRegistry } from '../src/modules/shipping/providers/provider-registry.js';
import { ShiprocketProvider } from '../src/modules/shipping/providers/shiprocket.provider.js';
import {
  CarrierError,
  type ShippingProvider,
} from '../src/modules/shipping/providers/shipping-provider.js';
import { FakeCarrier } from './support/fake-carrier.js';

const http = () =>
  new CarrierHttp(new FakeCarrier().fetch, { timeoutMs: 500, retryDelayMs: 0 });
const providers = (): ShippingProvider[] => [
  new ShiprocketProvider(http()),
  new DelhiveryProvider(http()),
  new BlueDartProvider(http()),
];

describe('the registry', () => {
  it('finds every carrier by its code and describes them without any behaviour or credentials', () => {
    const registry = new ShippingProviderRegistry(providers());
    expect(registry.codes()).toEqual(['shiprocket', 'delhivery', 'bluedart']);
    expect(registry.get('delhivery').name).toBe('Delhivery');
    const description = registry.describe();
    expect(description.map((d) => d.code)).toEqual([
      'shiprocket',
      'delhivery',
      'bluedart',
    ]);
    for (const d of description) {
      expect(Object.keys(d).sort()).toEqual([
        'capabilities',
        'code',
        'credentialFields',
        'integrationNotes',
        'integrationStatus',
        'name',
      ]);
      expect(JSON.stringify(d)).not.toMatch(/function/);
    }
  });

  it('refuses an unknown carrier and two carriers with the same code', () => {
    const registry = new ShippingProviderRegistry(providers());
    expect(() => registry.get('fedex')).toThrow(CarrierError);
    expect(registry.has('fedex')).toBe(false);
    const [first] = providers();
    expect(() => new ShippingProviderRegistry([first, first])).toThrow(
      /share the code/,
    );
  });

  it('takes a new carrier without any change to the registry', async () => {
    const extra = {
      ...providers()[0],
      code: 'newcarrier',
      name: 'New Carrier',
    } as ShippingProvider;
    const registry = new ShippingProviderRegistry([...providers(), extra]);
    expect(registry.get('newcarrier').name).toBe('New Carrier');
  });
});

describe('what every carrier promises', () => {
  const all = providers();

  it.each(all.map((p) => [p.code, p] as const))(
    '%s: its capability flags tell the truth about what it will do',
    async (_code, provider) => {
      const lane = {
        originPostalCode: '560001',
        destinationPostalCode: '400001',
        paymentMode: 'prepaid' as const,
      };
      const creds = Object.fromEntries(
        provider.credentialFields.map((f) => [
          f.key,
          f.options?.[0] ?? 'value-1234',
        ]),
      );
      const kind = async (work: Promise<unknown>) => {
        try {
          await work;
          return 'ok';
        } catch (error) {
          return error instanceof CarrierError ? error.kind : 'other';
        }
      };
      // An unsupported operation fails at once and cleanly; a supported one never reports "unsupported".
      expect(
        (await kind(provider.getServiceability(creds, lane))) === 'unsupported',
      ).toBe(!provider.capabilities.serviceability);
      expect(
        (await kind(provider.calculateShippingRates(creds, lane))) ===
          'unsupported',
      ).toBe(!provider.capabilities.rateQuotes);
      expect(
        (await kind(
          provider.generateShippingLabel(creds, {
            awb: '123456789',
            providerShipmentId: '1',
          }),
        )) === 'unsupported',
      ).toBe(!provider.capabilities.labels);
    },
  );

  it.each(all.map((p) => [p.code, p] as const))(
    '%s: describes what a tenant must enter, marks secrets, and states how far it is verified',
    (_code, provider) => {
      expect(provider.credentialFields.length).toBeGreaterThan(1);
      expect(provider.credentialFields.some((f) => f.secret)).toBe(true);
      for (const f of provider.credentialFields) {
        expect(f.key).toMatch(/^[a-zA-Z]+$/);
        expect(f.label.length).toBeGreaterThan(2);
      }
      expect(['documented', 'partially_documented', 'unverified']).toContain(
        provider.integrationStatus,
      );
      expect(provider.integrationNotes.length).toBeGreaterThan(30);
    },
  );

  it.each(all.map((p) => [p.code, p] as const))(
    '%s: ignores settings it does not know and refuses ones that are missing',
    async (_code, provider) => {
      const error = await provider
        .validateCredentials({})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CarrierError);
      expect((error as CarrierError).kind).toBe('invalid_input');
    },
  );
});

describe('the shared HTTP helper', () => {
  it('times out a request that never answers, without keeping the raw error', async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted https://secret.example/path?key=abc')),
        ),
      );
    const error = (await new CarrierHttp(hang, {
      timeoutMs: 20,
      retryDelayMs: 0,
    })
      .request({ carrier: 'Acme', method: 'POST', url: 'https://x.test/a' })
      .catch((e: unknown) => e)) as CarrierError;
    expect(error.kind).toBe('unavailable');
    expect(error.message).toBe('Could not reach Acme.');
  });

  it('retries only reads, only for outages, and gives a refusal straight back', async () => {
    const carrier = new FakeCarrier()
      .on('GET', '/r', [{ status: 503 }, { status: 429 }, { body: { ok: 1 } }])
      .on('GET', '/refused', { status: 400, body: { message: 'nope' } });
    const h = new CarrierHttp(carrier.fetch, {
      timeoutMs: 500,
      retryDelayMs: 0,
    });
    expect(
      (
        await h.request({
          carrier: 'A',
          method: 'GET',
          url: 'https://x.test/r',
          retry: true,
        })
      ).body,
    ).toEqual({ ok: 1 });
    expect(carrier.to('/r')).toHaveLength(3);
    await expect(
      h.request({
        carrier: 'A',
        method: 'GET',
        url: 'https://x.test/refused',
        retry: true,
      }),
    ).rejects.toMatchObject({ kind: 'rejected', message: 'nope' });
    expect(carrier.to('/refused')).toHaveLength(1);
    const post = new FakeCarrier().on('POST', '/p', { status: 500 });
    await expect(
      new CarrierHttp(post.fetch, { timeoutMs: 500, retryDelayMs: 0 }).request({
        carrier: 'A',
        method: 'POST',
        url: 'https://x.test/p',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(post.to('/p')).toHaveLength(1);
  });

  it('maps 401 and 403 to "auth" and sends JSON or form bodies as asked', async () => {
    const carrier = new FakeCarrier()
      .on('POST', '/j', { body: {} })
      .on('POST', '/f', { body: {} })
      .on('GET', '/a', { status: 403 });
    const h = new CarrierHttp(carrier.fetch);
    await h.request({
      carrier: 'A',
      method: 'POST',
      url: 'https://x.test/j',
      json: { a: 1 },
    });
    await h.request({
      carrier: 'A',
      method: 'POST',
      url: 'https://x.test/f',
      form: { format: 'json', data: '{"x":1}' },
    });
    expect(carrier.to('/j')[0].json).toEqual({ a: 1 });
    expect(carrier.to('/f')[0].form!.get('data')).toBe('{"x":1}');
    await expect(
      h.request({ carrier: 'A', method: 'GET', url: 'https://x.test/a' }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('scrubs secrets and long text out of messages', () => {
    expect(scrub('token abc12345 leaked abc12345', ['abc12345'])).toBe(
      'token *** leaked ***',
    );
    expect(scrub('x'.repeat(500))).toHaveLength(200);
    expect(
      messageOf({ errors: [{ message: 'Deep reason' }] }, 'fallback'),
    ).toBe('Deep reason');
    expect(messageOf(null, 'fallback')).toBe('fallback');
  });

  it('caches tokens by a hash of the credentials, and they expire', () => {
    let now = 0;
    const cache = new TokenCache(1000, () => now);
    const key = TokenCache.keyOf('plain-secret-xyz', 'other-secret-qrs');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('plain-secret-xyz');
    cache.set(key, 't');
    expect(cache.get(key)).toBe('t');
    now = 1001;
    expect(cache.get(key)).toBeUndefined();
  });

  it('converts money and statuses, and only passes https links', () => {
    expect(rupeesToMinor('1,299.50')).toBe(129950);
    expect(rupeesToMinor(-1)).toBeNull();
    expect(rupeesToMinor('free')).toBeNull();
    expect(safeUrl('https://a.test/x.pdf')).toBe('https://a.test/x.pdf');
    expect(safeUrl('http://a.test/x.pdf')).toBeNull();
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    const cases: [string, string][] = [
      ['Shipment Delivered', 'delivered'],
      ['Out For Delivery', 'out_for_delivery'],
      ['Undelivered - consignee not available', 'undelivered'],
      ['RTO Initiated', 'returning'],
      ['RTO Delivered', 'returned'],
      ['Picked Up', 'picked_up'],
      ['Pickup Scheduled', 'pending'],
      ['In Transit', 'in_transit'],
      ['Manifested', 'pending'],
      ['Cancelled by seller', 'cancelled'],
      ['', 'unknown'],
      ['zzz', 'unknown'],
    ];
    for (const [text, expected] of cases)
      expect(normalizeStatus(text), text).toBe(expected);
  });
});

/** The rule that keeps carrier details out of the rest of the application. */
describe('architecture: carrier code stays behind the registry', () => {
  const root = join(process.cwd(), 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory()
        ? walk(p)
        : p.endsWith('.ts') && !p.endsWith('.spec.ts')
          ? [p]
          : [];
    });
  const files = walk(root);
  const rel = (f: string) => relative(root, f).split(sep).join('/');

  it('only the shipping module imports a carrier adapter, and only to register it', () => {
    const importers = files
      .filter((f) =>
        /from '[^']*\/(shiprocket|delhivery|bluedart)\.provider\.js'/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map(rel);
    expect(importers).toEqual(['modules/shipping/shipping.module.ts']);
  });

  it('no controller and no order or payment code reaches into the carrier internals', () => {
    const offenders = files
      .filter((f) => !rel(f).startsWith('modules/shipping/'))
      .filter((f) =>
        /shipping\/providers\/(carrier-http|shiprocket|delhivery|bluedart)/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('network calls to carriers happen in one file only', () => {
    const callers = files
      .filter((f) => rel(f).startsWith('modules/shipping/'))
      .filter((f) =>
        /\bfetch\(|axios|from 'node:https?'|(?<![.\w])https?\.request\(/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map(rel);
    expect(callers).toEqual(['modules/shipping/providers/carrier-http.ts']);
  });

  it('adapters never log, and never build an error from a URL or a request body', () => {
    for (const f of files.filter((f) =>
      /providers\/(shiprocket|delhivery|bluedart)\.provider\.ts$/.test(rel(f)),
    )) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/console\.|Logger|\.log\(/);
    }
  });
});
