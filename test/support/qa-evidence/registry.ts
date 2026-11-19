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
}

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

function repoOf(location: string, layers: readonly Layer[]): RepoScope {
  if (/both repos/i.test(location)) return 'both';
  const frontend = layers.some((l) => l === 'FE' || l === 'PW');
  const api = layers.some(
    (l) => l === 'U' || l === 'PG' || l === 'HTTP' || l === 'REAL',
  );
  if (frontend && api) return 'both';
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
      repo: repoOf(location, layers),
      needsEnvironment: layers.includes('REAL') || layers.includes('PW'),
      blockedReason,
      initialStatus: blockedReason ? 'BLOCKED' : 'NOT RUN',
    });
  }
  return entries;
}
