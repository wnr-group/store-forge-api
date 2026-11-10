import { describe, expect, it } from 'vitest';
import { copyName, normalizeName } from './names.js';

const cp = (n: number) => '😀'.repeat(n);

describe('names (D20)', () => {
  it('AC-LIFE-003: counts code points, not UTF-16 units', () => {
    expect(normalizeName(cp(80))).toBe(cp(80));
    expect(normalizeName(cp(81))).toBeNull();
  });

  it('AC-LIFE-003: trims; rejects empty and whitespace-only', () => {
    expect(normalizeName('  a  ')).toBe('a');
    expect(normalizeName(' \t\n ')).toBeNull();
    expect(normalizeName('')).toBeNull();
  });

  it('AC-LIFE-002: copy name is "Copy of <name>" cut to 80 code points', () => {
    expect(copyName('Home')).toBe('Copy of Home');
    // oxlint-disable-next-line typescript/no-misused-spread
    expect([...copyName(cp(80))]).toHaveLength(80);
    expect(copyName('Template')).toBe('Copy of Template');
  });
});
