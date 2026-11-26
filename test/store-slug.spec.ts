import { describe, expect, it } from 'vitest';
import {
  slugCandidates,
  slugFromStoreName,
} from '../src/common/utils/store-slug.js';

describe('store address from a store name', () => {
  it('lower-cases, folds accents and joins words with single hyphens', () => {
    expect(slugFromStoreName('Blue Door Coffee')).toBe('blue-door-coffee');
    expect(slugFromStoreName('  Café   Zoë & Co. ')).toBe('cafe-zoe-co');
    expect(slugFromStoreName("Ravi's -- Store!!")).toBe('ravi-s-store');
  });

  it('keeps it short enough to leave room for a suffix', () => {
    const slug = slugFromStoreName('a'.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slugFromStoreName('word '.repeat(20)).endsWith('-')).toBe(false);
  });

  it('is empty when nothing usable is left', () => {
    expect(slugFromStoreName('!!! ???')).toBe('');
    expect(slugFromStoreName('दुकान')).toBe('');
  });

  it('offers the plain address first, then suffixed ones', () => {
    const c = slugCandidates('Blue Door');
    expect(c[0]).toBe('blue-door');
    expect(c.slice(1)).toHaveLength(5);
    for (const s of c.slice(1)) expect(s).toMatch(/^blue-door-[a-z0-9]{4}$/);
    expect(new Set(c).size).toBe(c.length);
  });

  it('never offers a plain address that is too short to be valid', () => {
    expect(slugCandidates('ab')[0]).toMatch(/^ab-[a-z0-9]{4}$/);
    for (const s of slugCandidates('!!!'))
      expect(s).toMatch(/^store-[a-z0-9]{4}$/);
  });

  it('only produces addresses the database accepts', () => {
    const valid = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
    for (const name of ['Blue Door', 'ab', '!!!', 'x'.repeat(100), 'Café Zoë'])
      for (const s of slugCandidates(name)) {
        expect(s).toMatch(valid);
        expect(s).not.toContain('--');
      }
  });
});
