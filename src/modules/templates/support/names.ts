import { LIMITS } from '../../../infrastructure/database/template-deps/limits.js';

// D20: 1–80 Unicode code points (spread into code points is intentional)
export const codePointLength = (s: string): number => {
  // oxlint-disable-next-line typescript/no-misused-spread
  return [...s].length;
};

/** Trimmed name when 1..80 code points, else null (caller throws VALIDATION). */
export function normalizeName(raw: string): string | null {
  const t = raw.trim();
  const n = codePointLength(t);
  return n >= 1 && n <= LIMITS.maxNameLength ? t : null;
}

export const copyName = (source: string): string => {
  // oxlint-disable-next-line typescript/no-misused-spread
  return [...`Copy of ${source}`].slice(0, LIMITS.maxNameLength).join('');
};
