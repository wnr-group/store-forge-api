import {
  HANDOFF_TTL_SECONDS,
  openHandoff,
  sealHandoff,
} from './handoff-code.js';

const SECRET = 's'.repeat(32);
const NOW = 1_800_000_000;

describe('session handoff code', () => {
  it('opens for the host it was made for', () => {
    const code = sealHandoff(SECRET, 'tok', 'urban-abc12', NOW);
    expect(openHandoff(SECRET, code, 'urban-abc12', NOW + 5)).toBe('tok');
  });

  it('is refused on any other host', () => {
    const code = sealHandoff(SECRET, 'tok', 'urban-abc12', NOW);
    expect(openHandoff(SECRET, code, 'other-abc12', NOW)).toBeNull();
  });

  it('expires', () => {
    const code = sealHandoff(SECRET, 'tok', 'urban-abc12', NOW);
    expect(
      openHandoff(SECRET, code, 'urban-abc12', NOW + HANDOFF_TTL_SECONDS),
    ).toBe('tok');
    expect(
      openHandoff(SECRET, code, 'urban-abc12', NOW + HANDOFF_TTL_SECONDS + 1),
    ).toBeNull();
  });

  it('is refused when signed with another secret or edited', () => {
    const code = sealHandoff(SECRET, 'tok', 'urban-abc12', NOW);
    expect(openHandoff('x'.repeat(32), code, 'urban-abc12', NOW)).toBeNull();
    const [body, mac] = code.split('.');
    const forged = Buffer.from(
      JSON.stringify({ t: 'other', a: 'urban-abc12', e: NOW + 60 }),
    ).toString('base64url');
    expect(
      openHandoff(SECRET, `${forged}.${mac}`, 'urban-abc12', NOW),
    ).toBeNull();
    expect(openHandoff(SECRET, `${body}.`, 'urban-abc12', NOW)).toBeNull();
  });

  it('is refused when it is not a code at all', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.b'])
      expect(openHandoff(SECRET, bad, 'urban-abc12', NOW)).toBeNull();
  });
});
