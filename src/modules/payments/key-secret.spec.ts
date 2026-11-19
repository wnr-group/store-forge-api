import {
  isValidKeySecret,
  KEY_SECRET_MAX_LENGTH,
  KEY_SECRET_MIN_LENGTH,
  KEY_SECRET_PATTERN,
} from './key-secret.js';

describe('Razorpay Key Secret format (approved rule) (AC-API-07)', () => {
  it('is exactly the approved pattern and bounds', () => {
    expect(KEY_SECRET_PATTERN.source).toBe('^[A-Za-z0-9]{16,128}$');
    expect(KEY_SECRET_MIN_LENGTH).toBe(16);
    expect(KEY_SECRET_MAX_LENGTH).toBe(128);
  });

  it.each([
    ['the minimum length (16)', 'a'.repeat(16)],
    ['the maximum length (128)', 'Z9'.repeat(64)],
    ['a typical 24-character mixed-case secret', 'aB3dE6gH9jK2mN5pQ8sT1vXy'],
    ['digits only', '1234567890123456'],
    ['upper-case only', 'ABCDEFGHIJKLMNOP'],
  ])('accepts %s', (_label, value) => {
    expect(isValidKeySecret(value)).toBe(true);
  });

  it.each([
    ['one character below the minimum (15)', 'a'.repeat(15)],
    ['one character above the maximum (129)', 'a'.repeat(129)],
    ['an empty string', ''],
    ['leading whitespace (never trimmed)', ` ${'a'.repeat(16)}`],
    ['trailing whitespace (never trimmed)', `${'a'.repeat(16)} `],
    ['an inner space', `${'a'.repeat(8)} ${'a'.repeat(8)}`],
    ['a trailing newline', `${'a'.repeat(16)}\n`],
    ['a symbol', `${'a'.repeat(15)}_`],
    ['a non-ASCII letter', `${'a'.repeat(15)}é`],
    ['a full-width digit', `${'a'.repeat(15)}１`],
  ])('rejects %s', (_label, value) => {
    expect(isValidKeySecret(value)).toBe(false);
  });

  it.each([undefined, null, 1234567890123456, {}, [], true])(
    'rejects the non-string %p',
    (value) => {
      expect(isValidKeySecret(value)).toBe(false);
    },
  );
});
