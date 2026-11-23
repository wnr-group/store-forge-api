import { describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import {
  mergeCredentials,
  toCredentials,
} from '../src/modules/shipping/carrier-credentials.js';
import type { CredentialField } from '../src/modules/shipping/providers/shipping-provider.js';

const FIELDS: CredentialField[] = [
  { key: 'email', label: 'Email', required: true, secret: false },
  { key: 'password', label: 'Password', required: true, secret: true },
  {
    key: 'environment',
    label: 'Environment',
    required: false,
    secret: false,
    options: ['production', 'staging'],
  },
  { key: 'gstin', label: 'GSTIN', required: false, secret: false },
];

function problems(work: () => unknown): Record<string, string> {
  try {
    work();
  } catch (error) {
    if (error instanceof AppException)
      return (error.details ?? {}) as Record<string, string>;
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('mergeCredentials', () => {
  it('splits what is submitted into readable settings and secrets, and lists what was set', () => {
    const merged = mergeCredentials(FIELDS, null, {
      email: ' a@b.co ',
      password: 'pw-secret-1',
      environment: 'staging',
    });
    expect(merged.settings).toEqual({
      email: 'a@b.co',
      environment: 'staging',
    });
    expect(merged.secrets).toEqual({ password: 'pw-secret-1' });
    expect(merged.changed.sort()).toEqual(['email', 'environment', 'password']);
  });

  it('keeps a secret that is left out, because secrets can never be read back', () => {
    const existing = {
      settings: { email: 'a@b.co' },
      secrets: { password: 'old-secret-1' },
    };
    const merged = mergeCredentials(FIELDS, existing, { email: 'new@b.co' });
    expect(merged.secrets).toEqual({ password: 'old-secret-1' });
    expect(merged.settings).toEqual({ email: 'new@b.co' });
    expect(merged.changed).toEqual(['email']);
  });

  it('replaces a secret that is sent, and reports no change when nothing differs', () => {
    const existing = {
      settings: { email: 'a@b.co' },
      secrets: { password: 'old-secret-1' },
    };
    expect(
      mergeCredentials(FIELDS, existing, { password: 'new-secret-2' }).secrets,
    ).toEqual({ password: 'new-secret-2' });
    expect(
      mergeCredentials(FIELDS, existing, {
        email: 'a@b.co',
        password: 'old-secret-1',
      }).changed,
    ).toEqual([]);
    expect(mergeCredentials(FIELDS, existing, {}).changed).toEqual([]);
  });

  it('clears an optional setting with an empty value but never a required one', () => {
    const existing = {
      settings: { email: 'a@b.co', gstin: '29ABCDE1234F1Z5' },
      secrets: { password: 'pw-secret-1' },
    };
    const merged = mergeCredentials(FIELDS, existing, { gstin: '   ' });
    expect(merged.settings).toEqual({ email: 'a@b.co' });
    expect(merged.changed).toEqual(['gstin']);
    expect(
      problems(() => mergeCredentials(FIELDS, existing, { email: '' })),
    ).toEqual({ email: 'This is required.' });
  });

  it('reports every problem at once, per field, in fixed words that never repeat what was typed', () => {
    const errors = problems(() =>
      mergeCredentials(FIELDS, null, {
        email: 'x'.repeat(300),
        password: 'bad\nvalue',
        environment: 'moon-SECRET',
        surprise: 'boom-SECRET',
        gstin: 42,
      }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      'email',
      'environment',
      'gstin',
      'password',
      'surprise',
    ]);
    expect(JSON.stringify(errors)).not.toContain('SECRET');
    expect(errors.surprise).toMatch(/does not exist/);
  });

  it('requires the required fields on a first connection', () => {
    expect(problems(() => mergeCredentials(FIELDS, null, {}))).toEqual({
      email: 'This is required.',
      password: 'This is required.',
    });
  });

  it('puts secrets and settings back together for the adapter', () => {
    expect(
      toCredentials({
        settings: { email: 'a@b.co' },
        secrets: { password: 'p' },
      }),
    ).toEqual({ email: 'a@b.co', password: 'p' });
  });
});
