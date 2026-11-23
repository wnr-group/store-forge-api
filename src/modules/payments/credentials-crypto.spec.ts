import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __testing,
  CredentialsTooLargeError,
  encryptSecret,
  MAX_CIPHERTEXT_CHARS,
  type EncryptedSecret,
} from './credentials-crypto.js';
import { CredentialsKeyError } from './credentials-key.js';

const { decryptSecret } = __testing;

const newKey = () => randomBytes(32).toString('base64');
const envWith = (key = newKey()) => ({
  CREDENTIALS_ENCRYPTION_KEY_V1: key,
  CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
});
const SYNTH = 'SYNTH-secret-Ab12Cd34Ef56Gh78';

/** Flips one bit of a base64 value, keeping it valid base64 of the same length. */
function flip(b64: string, byteIndex = 0): string {
  const bytes = Buffer.from(b64, 'base64');
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('AES-256-GCM credentials encryption', () => {
  const tenantId = randomUUID();
  const env = envWith();

  it('round-trips a secret (AC-ENC-01), including non-ASCII text', () => {
    for (const secret of [SYNTH, 'päss-wörd-✓-密码']) {
      const enc = encryptSecret(secret, tenantId, env);
      expect(decryptSecret(enc, tenantId, env)).toBe(secret);
    }
  });

  it('returns base64 parts with a 12-byte IV, a 16-byte tag and the key version', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(Buffer.from(enc.iv, 'base64')).toHaveLength(12);
    expect(enc.iv).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect(Buffer.from(enc.authTag, 'base64')).toHaveLength(16);
    expect(enc.authTag).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(enc.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(enc.keyVersion).toBe(1);
  });

  it('does not store the plaintext, in any common encoding (AC-ENC-06 unit half)', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    const all = JSON.stringify(enc);
    expect(all).not.toContain(SYNTH);
    expect(enc.ciphertext).not.toBe(Buffer.from(SYNTH).toString('base64'));
    expect(
      Buffer.from(enc.ciphertext, 'base64').toString('utf8'),
    ).not.toContain(SYNTH);
  });

  it('uses a fresh IV for every write, so the same secret never repeats (AC-ENC-07)', () => {
    const a = encryptSecret(SYNTH, tenantId, env);
    const b = encryptSecret(SYNTH, tenantId, env);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.authTag).not.toBe(b.authTag);
  });

  it('rejects a tampered ciphertext (AC-ENC-02)', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(() =>
      decryptSecret(
        { ...enc, ciphertext: flip(enc.ciphertext) },
        tenantId,
        env,
      ),
    ).toThrow();
  });

  it('rejects a tampered authentication tag (AC-ENC-03)', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(() =>
      decryptSecret({ ...enc, authTag: flip(enc.authTag, 3) }, tenantId, env),
    ).toThrow();
  });

  it('rejects a tampered IV', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(() =>
      decryptSecret({ ...enc, iv: flip(enc.iv) }, tenantId, env),
    ).toThrow();
  });

  it('binds the ciphertext to the tenant: another tenant id cannot decrypt it (AC-ENC-04)', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(() => decryptSecret(enc, randomUUID(), env)).toThrow();
  });

  it('treats the tenant id case-insensitively, so database casing cannot break decryption', () => {
    const enc = encryptSecret(SYNTH, tenantId.toLowerCase(), env);
    expect(decryptSecret(enc, tenantId.toUpperCase(), env)).toBe(SYNTH);
  });

  it('cannot be decrypted with a different key (AC-ENC-05)', () => {
    const enc = encryptSecret(SYNTH, tenantId, env);
    expect(() => decryptSecret(enc, tenantId, envWith())).toThrow();
  });

  it('records the active key version and still decrypts old versions after a rotation', () => {
    const k1 = newKey();
    const k2 = newKey();
    const before = encryptSecret(SYNTH, tenantId, envWith(k1));
    const rotated = {
      CREDENTIALS_ENCRYPTION_KEY_V1: k1,
      CREDENTIALS_ENCRYPTION_KEY_V2: k2,
      CREDENTIALS_ENCRYPTION_KEY_CURRENT: '2',
    };
    const after = encryptSecret(SYNTH, tenantId, rotated);
    expect(before.keyVersion).toBe(1);
    expect(after.keyVersion).toBe(2);
    expect(decryptSecret(before, tenantId, rotated)).toBe(SYNTH);
    expect(decryptSecret(after, tenantId, rotated)).toBe(SYNTH);
  });

  it('refuses an empty secret and a malformed tenant id', () => {
    expect(() => encryptSecret('', tenantId, env)).toThrow(TypeError);
    expect(() => encryptSecret(SYNTH, '', env)).toThrow(TypeError);
    expect(() => encryptSecret(SYNTH, 'not-a-uuid', env)).toThrow(TypeError);
  });

  describe('ciphertext storage cap (AC-ENC-10, AC-DB-05)', () => {
    it('accepts the largest input whose ciphertext still fits in 2048 base64 characters', () => {
      expect(MAX_CIPHERTEXT_CHARS).toBe(2048);
      const enc = encryptSecret('a'.repeat(1536), tenantId, env);
      expect(enc.ciphertext).toHaveLength(2048);
      expect(decryptSecret(enc, tenantId, env)).toBe('a'.repeat(1536));
    });

    it('rejects the first input that would exceed it, without truncating', () => {
      expect(() => encryptSecret('a'.repeat(1537), tenantId, env)).toThrow(
        CredentialsTooLargeError,
      );
    });

    it('the over-cap error carries no secret', () => {
      const secret = 'S'.repeat(1537);
      try {
        encryptSecret(secret, tenantId, env);
      } catch (e) {
        const text = [(e as Error).message, (e as Error).stack ?? ''].join(
          '\n',
        );
        expect(text).not.toContain('SSSSSSSS');
        return;
      }
      throw new Error('expected the over-cap input to be rejected');
    });
  });

  describe('key failures are fail-closed and leak nothing', () => {
    it.each([
      ['no key configured', {}, 'key_missing'],
      [
        'CURRENT missing',
        { CREDENTIALS_ENCRYPTION_KEY_V1: newKey() },
        'key_missing',
      ],
      [
        'an invalid key',
        {
          CREDENTIALS_ENCRYPTION_KEY_V1: 'abc',
          CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
        },
        'key_invalid',
      ],
    ] as const)('%s', (_label, badEnv, category) => {
      try {
        encryptSecret(SYNTH, tenantId, badEnv);
      } catch (e) {
        expect(e).toBeInstanceOf(CredentialsKeyError);
        expect((e as CredentialsKeyError).category).toBe(category);
        expect(
          [(e as Error).message, (e as Error).stack ?? ''].join('\n'),
        ).not.toContain(SYNTH);
        return;
      }
      throw new Error('expected encryption to fail closed');
    });

    it('produces no ciphertext when the key is unusable', () => {
      let out: EncryptedSecret | undefined;
      try {
        out = encryptSecret(SYNTH, tenantId, {});
      } catch {
        // expected
      }
      expect(out).toBeUndefined();
    });
  });
});

/** AC-ENC-09: nothing in production code can decrypt a stored secret. */
describe('no decryption path in production code', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const files = (readdirSync(root, { recursive: true }) as string[])
    .map((f) => join(root, f))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('references decryptSecret and __testing only in the crypto module and the one reviewed reader (AC-ENC-09) [layer:STATIC]', () => {
    const offenders = files
      .filter((f) => /decryptSecret|__testing/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split(sep).join('/'));
    expect(offenders).toEqual([
      'modules/payments/credentials-crypto.ts',
      'modules/payments/razorpay-credentials.ts',
    ]);
  });

  it('lets only the connection, payment-flow and webhook services use the credentials reader (AC-ENC-09) [layer:STATIC]', () => {
    const users = files
      .filter((f) =>
        /from '[^']*razorpay-credentials\.js'/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(root, f).split(sep).join('/'));
    expect(users).toEqual([
      'modules/checkout-payments/payment-reconciliation.service.ts',
      'modules/checkout-payments/razorpay-payments.service.ts',
      'modules/checkout-payments/razorpay-webhook.service.ts',
      'modules/payments/razorpay-connection.service.ts',
      'modules/payments/refunds.service.ts',
    ]);
  });

  it('never re-exports the crypto module from a barrel or wires it as a provider (AC-ENC-09) [layer:STATIC]', () => {
    const importers = files
      .filter((f) => /credentials-crypto/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split(sep).join('/'));
    expect(
      importers.filter((f) => /\/index\.ts$|\.module\.ts$/.test(f)),
    ).toEqual([]);
  });
});
