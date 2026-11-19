/**
 * Verification layers, and how a test result or a plan-matrix row is tied to them. The layers are the ones defined in the
 * implementation plan ("Verification layers"): each proves different things, so an acceptance criterion is only complete
 * when every layer its row requires has produced a passing result.
 */

export const LAYERS = [
  'U',
  'PG',
  'HTTP',
  'REAL',
  'FE',
  'PW',
  'STATIC',
  'M',
] as const;
export type Layer = (typeof LAYERS)[number];

const isLayer = (value: string): value is Layer =>
  (LAYERS as readonly string[]).includes(value);

const AC_ID = /\bAC-[A-Z]+-\d+[a-z]?\b/g;

/** Every acceptance-criterion id mentioned in a test's full name, once each, in order of appearance. */
export function acTagsOf(fullName: string): string[] {
  return [...new Set(fullName.match(AC_ID) ?? [])];
}

/**
 * The layer a test belongs to: an explicit `[layer:X]` tag in its name wins; otherwise the file decides. Database tests
 * run against the migrated PGlite database, other e2e files drive the real HTTP application.
 */
export function layerOfTest(file: string, fullName: string): Layer | undefined {
  const tagged = /\[layer:([A-Z]+)\]/.exec(fullName)?.[1];
  if (tagged && isLayer(tagged)) return tagged;
  const path = file.replace(/\\/g, '/');
  if (/\/payments-database[^/]*\.e2e-spec\.ts$/.test(path)) return 'PG';
  if (/\.(e2e|int)-spec\.ts$/.test(path)) return 'HTTP';
  if (path.endsWith('.spec.ts')) return 'U';
  return undefined;
}

const AUTOMATED_SEGMENT =
  /\b((?:U|PG|HTTP|REAL|FE|PW|STATIC)(?:\+(?:U|PG|HTTP|REAL|FE|PW|STATIC))*) A\b/g;

/**
 * The layers a matrix row's "Method / test" cell asks for. In the plan every automated layer is written as `<LAYER> A`
 * (several joined with `+`), and a manual step as `M`. A layer word that is not followed by ` A` (for example the word
 * HTTP inside "REAL A HTTP to /rest/v1/...") is prose, not a requirement. Returned in the canonical layer order.
 */
export function layersOfMethod(cell: string): Layer[] {
  const found = new Set<Layer>();
  for (const match of cell.matchAll(AUTOMATED_SEGMENT))
    for (const part of (match[1] ?? '').split('+'))
      if (isLayer(part)) found.add(part);
  if (/(?:^|[;(]\s*)M(?= review| step)/.test(cell)) found.add('M');
  return LAYERS.filter((l) => found.has(l));
}
