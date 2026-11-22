/** WCAG 2.x contrast between two explicit #rrggbb colours. Anything else is "unknown", never a pass. */

const HEX = /^#[0-9a-fA-F]{6}$/;

export const isHexColor = (v: unknown): v is string =>
  typeof v === 'string' && HEX.test(v);

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export type ContrastLevel = 'below-3' | 'below-4.5' | 'ok';

/** Below 3 is a blocker, from 3 up to (not including) 4.5 a warning, 4.5 and above passes. Boundaries are inclusive upward. */
export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio < 3) return 'below-3';
  if (ratio < 4.5) return 'below-4.5';
  return 'ok';
}
