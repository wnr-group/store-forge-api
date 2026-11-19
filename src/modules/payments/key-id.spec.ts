import {
  isValidKeyId,
  KEY_ID_PATTERN,
  maskKeyId,
  razorpayModeOf,
} from './key-id.js';

const TEST_ID = 'rzp_test_AbCdEfGh12345678';
const LIVE_ID = 'rzp_live_Zy9Xw8Vu7Ts6Rq5P';

describe('Razorpay Key ID format (approved regex) (AC-API-06)', () => {
  it('is exactly the approved pattern', () => {
    expect(KEY_ID_PATTERN.source).toBe('^rzp_(test|live)_[A-Za-z0-9]{8,}$');
  });

  it.each([
    ['a test id', TEST_ID],
    ['a live id', LIVE_ID],
    ['the shortest suffix (8 characters)', 'rzp_test_abcdefgh'],
    ['a long suffix', `rzp_live_${'a1'.repeat(40)}`],
    ['digits only in the suffix', 'rzp_test_12345678'],
  ])('accepts %s', (_label, value) => {
    expect(isValidKeyId(value)).toBe(true);
  });

  it.each([
    ['a 7-character suffix, one short of the minimum', 'rzp_test_abcdefg'],
    ['an empty suffix', 'rzp_test_'],
    ['an unknown mode', 'rzp_demo_abcdefgh'],
    ['an upper-case prefix', 'RZP_test_abcdefgh'],
    ['no prefix', 'abcdefghijklmnop'],
    ['a symbol in the suffix', 'rzp_test_abcd-efgh'],
    ['an underscore in the suffix', 'rzp_test_abcd_efgh'],
    ['leading whitespace', ' rzp_test_abcdefgh'],
    ['trailing whitespace', 'rzp_test_abcdefgh '],
    ['a trailing newline', 'rzp_test_abcdefgh\n'],
    ['an embedded newline', 'rzp_test_abcd\nefgh'],
    ['a non-ASCII letter', 'rzp_test_abcdefgé'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidKeyId(value)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ['rzp_test_abcdefgh']])(
    'rejects a non-string (%j)',
    (value) => {
      expect(isValidKeyId(value)).toBe(false);
    },
  );
});

describe('mode derived from the Key ID prefix (AC-API-15)', () => {
  it('reads test and live from the prefix and stores nothing extra', () => {
    expect(razorpayModeOf(TEST_ID)).toBe('test');
    expect(razorpayModeOf(LIVE_ID)).toBe('live');
  });

  it('refuses to guess for a value that is not a valid Key ID', () => {
    for (const bad of ['rzp_demo_abcdefgh', 'rzp_test_short', '', 'x'])
      expect(() => razorpayModeOf(bad), bad).toThrow(TypeError);
  });
});

describe('Key ID masking (AC-API-14)', () => {
  it('shows the prefix and the last four characters only', () => {
    expect(maskKeyId(TEST_ID)).toBe('rzp_test_••••5678');
    expect(maskKeyId(LIVE_ID)).toBe('rzp_live_••••Rq5P');
  });

  it('never reveals any other part of the id', () => {
    const masked = maskKeyId(TEST_ID);
    expect(masked).not.toContain('AbCdEfGh');
    expect(masked).not.toContain('1234');
    expect(masked).toHaveLength('rzp_test_'.length + 4 + 4);
  });

  it('is the same width for every id, so it does not reveal the length', () => {
    expect(maskKeyId('rzp_test_abcdefgh')).toHaveLength(
      maskKeyId(`rzp_test_${'a'.repeat(60)}`).length,
    );
  });

  it('hides at least four characters even for the shortest valid id', () => {
    const shortest = 'rzp_test_ABCDEFGH';
    const masked = maskKeyId(shortest);
    expect(masked).toBe('rzp_test_••••EFGH');
    expect(masked).not.toContain('ABCD');
  });

  it('refuses to mask something that is not a valid Key ID', () => {
    expect(() => maskKeyId('rzp_test_abc')).toThrow(TypeError);
    expect(() => maskKeyId('')).toThrow(TypeError);
  });
});
