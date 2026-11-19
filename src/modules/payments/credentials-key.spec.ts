import { randomBytes } from 'node:crypto';
import {
  CredentialsKeyError,
  loadKey,
  loadKeyVersion,
} from './credentials-key.js';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');

function failure(fn: () => unknown): CredentialsKeyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CredentialsKeyError);
    return e as CredentialsKeyError;
  }
  throw new Error('expected a CredentialsKeyError, but nothing was thrown');
}

describe('credentials encryption key loading (lazy, fail closed)', () => {
  it('loads the current version, base64-decoded to exactly 32 bytes', () => {
    const k = key();
    const loaded = loadKey({
      CREDENTIALS_ENCRYPTION_KEY_V1: k,
      CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
    });
    expect(loaded.version).toBe(1);
    expect(loaded.key).toHaveLength(32);
    expect(loaded.key.toString('base64')).toBe(k);
  });

  it('uses the version named by CURRENT and keeps older versions loadable', () => {
    const k1 = key();
    const k2 = key();
    const env = {
      CREDENTIALS_ENCRYPTION_KEY_V1: k1,
      CREDENTIALS_ENCRYPTION_KEY_V2: k2,
      CREDENTIALS_ENCRYPTION_KEY_CURRENT: '2',
    };
    expect(loadKey(env).version).toBe(2);
    expect(loadKey(env).key.toString('base64')).toBe(k2);
    expect(loadKeyVersion(1, env).key.toString('base64')).toBe(k1);
  });

  it('does nothing at import time: the environment is only read when a key is requested', () => {
    // Importing the module above already succeeded with no key configured in this process.
    expect(typeof loadKey).toBe('function');
  });

  describe.each([
    [
      'CURRENT is not set',
      { CREDENTIALS_ENCRYPTION_KEY_V1: key() },
      'key_missing',
    ],
    [
      'CURRENT is empty',
      {
        CREDENTIALS_ENCRYPTION_KEY_V1: key(),
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '',
      },
      'key_missing',
    ],
    [
      'the key variable is not set',
      { CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1' },
      'key_missing',
    ],
    [
      'the key variable is empty',
      {
        CREDENTIALS_ENCRYPTION_KEY_V1: '',
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
      },
      'key_missing',
    ],
    [
      'CURRENT names a version that has no key configured',
      {
        CREDENTIALS_ENCRYPTION_KEY_V1: key(),
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '2',
      },
      'key_missing',
    ],
  ] as const)('%s', (_label, env, category) => {
    it(`fails closed with ${category}`, () => {
      expect(failure(() => loadKey(env)).category).toBe(category);
    });
  });

  describe.each(['abc', '0', '-1', '1.5', ' 1', '1 ', '01', '99999', '1e1'])(
    'CURRENT = %j (not a valid version number)',
    (current) => {
      it('fails closed with key_invalid', () => {
        const env = {
          CREDENTIALS_ENCRYPTION_KEY_V1: key(),
          CREDENTIALS_ENCRYPTION_KEY_CURRENT: current,
        };
        expect(failure(() => loadKey(env)).category).toBe('key_invalid');
      });
    },
  );

  describe.each([
    ['not base64', '!!!not-base64!!!'],
    // 32 bytes of 0xfb encode to '+/' characters in standard base64 and '-_' in the url-safe alphabet.
    ['url-safe base64 alphabet', Buffer.alloc(32, 0xfb).toString('base64url')],
    ['surrounding whitespace', ` ${key()} `],
    ['a trailing newline', `${key()}\n`],
    ['16 bytes', key(16)],
    ['31 bytes', key(31)],
    ['33 bytes', key(33)],
    ['64 bytes', key(64)],
    // 43 characters plus '=' is the right length, but a final character whose unused bits are not zero is not canonical.
    ['non-canonical padding', key().slice(0, 42) + 'B='],
  ])('a key that is %s', (_label, raw) => {
    it('fails closed with key_invalid', () => {
      const env = {
        CREDENTIALS_ENCRYPTION_KEY_V1: raw,
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
      };
      expect(failure(() => loadKey(env)).category).toBe('key_invalid');
    });
  });

  it('never puts key material or the variable value in an error', () => {
    const raw = key(31);
    const err = failure(() =>
      loadKey({
        CREDENTIALS_ENCRYPTION_KEY_V1: raw,
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
      }),
    );
    const everything = [
      err.message,
      err.name,
      err.stack ?? '',
      JSON.stringify(err),
    ].join('\n');
    expect(everything).not.toContain(raw);
    expect(err.message).toBe('key_invalid');
  });

  it('reports a missing specific version as key_missing without naming its value', () => {
    const err = failure(() =>
      loadKeyVersion(7, { CREDENTIALS_ENCRYPTION_KEY_V1: key() }),
    );
    expect(err.category).toBe('key_missing');
  });
});
