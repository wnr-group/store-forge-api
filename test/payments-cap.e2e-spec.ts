import { describe, expect, it, vi } from 'vitest';
import { migrationsAvailable } from './support/pglite.js';
import { SECRET, usePaymentsHttp } from './support/payments-http.js';

/**
 * The encryption output cap, through HTTP. A real secret (at most 128 characters) can never produce more than 2048 base64
 * characters, so the only way to reach the check is to make the encrypt function report an over-cap result. That function is
 * therefore replaced HERE, and only here, by one that throws the module's own over-cap error. What this proves is what the
 * service and the filter do with that error: reject the request, write nothing, leak nothing. It does not prove the real
 * encrypt function's own length check, which its unit test covers.
 */
vi.mock(
  '../src/modules/payments/credentials-crypto.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../src/modules/payments/credentials-crypto.js')
      >();
    return {
      ...actual,
      encryptSecret: () => {
        throw new actual.CredentialsTooLargeError();
      },
    };
  },
);

describe.skipIf(!migrationsAvailable)(
  'payments: over-cap encryption output (HTTP e2e, encrypt function replaced)',
  () => {
    const h = usePaymentsHttp();

    it('AC-ENC-10: an over-cap encryption result is rejected before persistence and nothing is written', async () => {
      await h.clear();
      const res = await h.put(h.w.alice, h.w.tenantA);
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(await h.count()).toBe(0);
    });
  },
);
