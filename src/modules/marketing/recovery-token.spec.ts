import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialsKeyError } from '../payments/credentials-key.js';
import {
  cartKeyHash,
  looksLikeRecoveryToken,
  recoveryTokenFor,
  recoveryTokenHash,
  sameHash,
} from './recovery-token.js';

const env = (n = 1) => ({
  CREDENTIALS_ENCRYPTION_KEY_V1: randomBytes(32).toString('base64'),
  CREDENTIALS_ENCRYPTION_KEY_CURRENT: String(n),
});
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('recovery tokens', () => {
  it('are stable for one cart and differ between carts, tenants and keys', () => {
    const e = env();
    const a = recoveryTokenFor(T1, C1, e);
    expect(recoveryTokenFor(T1, C1, e)).toBe(a);
    expect(recoveryTokenFor(T1.toUpperCase(), C1.toUpperCase(), e)).toBe(a);
    expect(recoveryTokenFor(T1, C2, e)).not.toBe(a);
    expect(recoveryTokenFor(T2, C1, e)).not.toBe(a);
    expect(recoveryTokenFor(T1, C1, env())).not.toBe(a);
  });

  it('have the one shape the lookup accepts', () => {
    const token = recoveryTokenFor(T1, C1, env());
    expect(looksLikeRecoveryToken(token)).toBe(true);
    for (const bad of [
      '',
      'short',
      `${token}x`,
      `${token.slice(1)}!`,
      ' '.repeat(43),
    ])
      expect(looksLikeRecoveryToken(bad)).toBe(false);
  });

  it('are stored only as a hash that cannot be turned back into the token', () => {
    const token = recoveryTokenFor(T1, C1, env());
    const hash = recoveryTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(sameHash(hash, recoveryTokenHash(token))).toBe(true);
    expect(sameHash(hash, recoveryTokenHash(`${token}a`))).toBe(false);
  });

  it('fail closed when the server has no usable key', () => {
    expect(() => recoveryTokenFor(T1, C1, {})).toThrow(CredentialsKeyError);
    expect(() =>
      recoveryTokenFor(T1, C1, {
        CREDENTIALS_ENCRYPTION_KEY_V1: 'not-a-key',
        CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
      }),
    ).toThrow(CredentialsKeyError);
  });

  it('keeps the browser cart id only as a hash, in its own namespace', () => {
    const h = cartKeyHash('0123456789abcdef');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('0123456789abcdef');
    expect(h).not.toBe(recoveryTokenHash('0123456789abcdef'));
  });
});
