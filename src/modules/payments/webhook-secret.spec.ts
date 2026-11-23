import { describe, expect, it } from 'vitest';
import { isValidWebhookSecret } from './webhook-secret.js';

describe('isValidWebhookSecret', () => {
  it.each(['abcd1234', 'My$ecret!Value#2024', 'a'.repeat(128)])(
    'accepts %s',
    (value) => {
      expect(isValidWebhookSecret(value)).toBe(true);
    },
  );

  it.each([
    'short',
    'a'.repeat(129),
    'has space1',
    ' padded123',
    'tab\tinside1',
    'ünïcödé-secret',
    '',
    undefined,
    42,
  ])('rejects %s', (value) => {
    expect(isValidWebhookSecret(value)).toBe(false);
  });
});
