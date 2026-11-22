import { layersOfMethod, type Layer } from './layers.js';

/**
 * The acceptance-criteria registry: one machine-readable entry per row of the frozen plan's traceability matrix.
 * It is generated from that matrix (never retyped), so the manifest builder judges every criterion against exactly the
 * layers, evidence files and blockers the plan states.
 */

export type RepoScope = 'api' | 'frontend' | 'both';

export interface AcRegistryEntry {
  acId: string;
  /** Matrix section, e.g. `7.2`. */
  section: string;
  requirement: string;
  location: string;
  method: string;
  /** Every layer the row requires, in canonical order. */
  layers: Layer[];
  preconditions: string;
  expected: string;
  /** Paths relative to the evidence root. */
  evidenceFiles: string[];
  repo: RepoScope;
  /** True when a layer needs a real database or a browser against a running stack (REAL, PW). */
  needsEnvironment: boolean;
  /** Set when the plan itself marks the row BLOCKED, with the stated reason. */
  blockedReason: string | undefined;
  initialStatus: 'NOT RUN' | 'BLOCKED';
  /**
   * Existing test files a regression row names (`AC-REG-*`). The manifest compares each against the baseline report:
   * nothing that passed at the baseline may fail or disappear.
   */
  regressionSpecs: string[];
  /** Other criteria that must be DONE before this one can be (the row's text asks for more than its test file shows). */
  dependsOn: string[];
}

/**
 * Where a matrix row's wording asks for something beyond what its named test files prove, the part that is proven
 * elsewhere is listed here, so the row cannot be DONE while that criterion is not. Reviewed, not inferred.
 */
export const EXPLICIT_DEPENDENCIES: Readonly<
  Record<string, readonly string[]>
> = {
  // "Existing tenant deletion works and now also removes the new row": the second half is the cascade criterion.
  'AC-REG-09': ['AC-RLS-15'],
  // "Existing tenant APIs unchanged; flag not exposed": the second half is the no-exposure criterion.
  'AC-REG-08': ['AC-DB-11'],
};

const ID_CELL = /^AC-[A-Z]+-\d+[a-z]?$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function evidenceFilesOf(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

/** Backticked test-file paths in a method cell, e.g. `test/store-team.e2e-spec.ts`. */
function testFilesOf(method: string): string[] {
  return [
    ...method.matchAll(
      /`((?:test|tests|src)\/[^`]+\.(?:e2e-spec|int-spec|spec|test)\.ts)`/g,
    ),
  ].map((m) => m[1] ?? '');
}

function repoOf(
  acId: string,
  location: string,
  layers: readonly Layer[],
): RepoScope {
  if (/both repos/i.test(location)) return 'both';
  const frontend = layers.some((l) => l === 'FE' || l === 'PW');
  const api = layers.some(
    (l) => l === 'U' || l === 'PG' || l === 'HTTP' || l === 'REAL',
  );
  if (frontend && api) return 'both';
  // A static-only row has no layer that names a repository: the frontend ids (AC-FE-*) own theirs, everything else is the API's.
  if (!frontend && !api && acId.startsWith('AC-FE-')) return 'frontend';
  return frontend ? 'frontend' : 'api';
}

function blockedReasonOf(status: string): string | undefined {
  if (!/\bBLOCKED\b/.test(status)) return undefined;
  return /BLOCKED \(([^)]+)\)/.exec(status)?.[1] ?? 'blocked';
}

/**
 * Parses every `| AC-... |` row of the matrix. Nine-column rows are `id, requirement, location, method, preconditions,
 * expected, evidence, result, status`; the regression table has seven (`... method, evidence, result, status`).
 */
export function parsePlanMatrix(markdown: string): AcRegistryEntry[] {
  const entries: AcRegistryEntry[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^###\s+(\d+\.\d+)\b/.exec(line);
    if (heading) {
      section = heading[1] ?? '';
      continue;
    }
    if (!line.trim().startsWith('| AC-')) continue;
    const c = cells(line);
    if (!ID_CELL.test(c[0] ?? '')) continue;

    const nine = c.length >= 9;
    const [acId = '', requirement = '', location = '', method = ''] = c;
    const preconditions = nine ? (c[4] ?? '') : '';
    const expected = nine ? (c[5] ?? '') : '';
    const evidenceCell = nine ? (c[6] ?? '') : (c[4] ?? '');
    const status = c[c.length - 1] ?? '';

    const layers = layersOfMethod(method);
    const blockedReason = blockedReasonOf(status);
    entries.push({
      acId,
      section,
      requirement,
      location,
      method,
      layers,
      preconditions,
      expected,
      evidenceFiles: evidenceFilesOf(evidenceCell),
      repo: repoOf(acId, location, layers),
      needsEnvironment: layers.includes('REAL') || layers.includes('PW'),
      blockedReason,
      initialStatus: blockedReason ? 'BLOCKED' : 'NOT RUN',
      regressionSpecs: acId.startsWith('AC-REG-') ? testFilesOf(method) : [],
      dependsOn: [...(EXPLICIT_DEPENDENCIES[acId] ?? [])],
    });
  }
  return entries;
}
