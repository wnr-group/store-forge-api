import { acTagsOf, layerOfTest, LAYERS, type Layer } from './layers.js';
import type { AcRegistryEntry } from './registry.js';
import type { EvidenceEnvironment } from './writer.js';

/**
 * Builds the evidence manifest and decides every acceptance criterion's status from facts only:
 *
 *  - which tests (tagged with the criterion's id in their name) really passed or failed, and in which layer;
 *  - whether every layer the plan requires for the criterion produced a passing result;
 *  - whether each required artifact exists, has content and has provenance (an entry written by an executed test after
 *    its assertion, or a per-AC extract this very run generated);
 *  - whether the secret scan of the whole evidence folder was clean.
 *
 * DONE needs all of them. A file existing is never enough, and a criterion proven only in one layer (for example unit
 * tests where the plan also asks for the HTTP layer) is NOT VERIFIED, not DONE.
 */

export const STATUSES = [
  'DONE',
  'FAILED',
  'BLOCKED',
  'NOT RUN',
  'NOT VERIFIED',
  'WAIVED',
] as const;
export type AcStatus = (typeof STATUSES)[number];

export interface TestResult {
  file: string;
  fullName: string;
  status: string;
  layer?: Layer | undefined;
}

export interface ReportInput {
  /** Path of the saved report, relative to the evidence root. */
  path: string;
  sha256: string;
  command: string;
  environment: EvidenceEnvironment;
  results: TestResult[];
}

export interface EvidenceEntry {
  acId: string;
  artifact: string;
  testName: string;
  testFile: string;
  layer: Layer;
  environment: EvidenceEnvironment;
  actualResult: string;
  timestamp: string;
}

export interface Waiver {
  acId: string;
  reason: string;
  approvedBy: string;
  date: string;
}

export interface RunMeta {
  repo: string;
  scope: 'api' | 'frontend';
  branch: string;
  commit: string;
  dirty: boolean;
  node: string;
  generatedAt: string;
}

export interface BuildInput {
  registry: AcRegistryEntry[];
  reports: ReportInput[];
  entries: EvidenceEntry[];
  /** Size and SHA-256 of an artifact, or undefined when it is not on disk. */
  files: (
    relativePath: string,
  ) => { bytes: number; sha256: string } | undefined;
  /** Extracts the builder wrote in this run (the only builder-made files accepted as evidence). */
  generated?: string[];
  scan: { status: 'clean' | 'dirty' | 'missing'; scannedFiles: number };
  waivers: Waiver[];
  meta: RunMeta;
}

export interface AcArtifact {
  file: string;
  present: boolean;
  bytes?: number;
  sha256?: string;
  provenance: 'entry' | 'builder' | 'none';
}

export interface AcResult {
  acId: string;
  section: string;
  requirement: string;
  requiredLayers: Layer[];
  observedLayers: Layer[];
  needsEnvironment: boolean;
  status: AcStatus;
  reason: string;
  tests: {
    file: string;
    fullName: string;
    layer: Layer | undefined;
    status: string;
    report: string;
  }[];
  artifacts: AcArtifact[];
  waiver?: Waiver;
}

export interface EvidenceRecord {
  acId: string;
  artifact: string;
  sha256: string;
  repo: string;
  commit: string;
  testName: string;
  command: string;
  timestamp: string;
  environment: string;
  actualResult: string;
  status: AcStatus;
}

export interface Manifest {
  meta: RunMeta;
  scan: BuildInput['scan'];
  reports: {
    path: string;
    sha256: string;
    command: string;
    environment: string;
    tests: number;
  }[];
  summary: {
    total: number;
    outOfScope: number;
    byStatus: Record<AcStatus, number>;
  };
  acs: AcResult[];
  records: EvidenceRecord[];
}

const inScope = (entry: AcRegistryEntry, scope: RunMeta['scope']) =>
  entry.repo === 'both' || entry.repo === scope;

export function buildManifest(input: BuildInput): Manifest {
  const { registry, reports, entries, files, scan, waivers, meta } = input;
  const generated = new Set(input.generated ?? []);
  const acs: AcResult[] = [];
  const records: EvidenceRecord[] = [];
  let outOfScope = 0;

  for (const entry of registry) {
    if (!inScope(entry, meta.scope)) {
      outOfScope += 1;
      continue;
    }
    const tests = reports.flatMap((r) =>
      r.results
        .filter((t) => acTagsOf(t.fullName).includes(entry.acId))
        .map((t) => ({
          file: t.file,
          fullName: t.fullName,
          layer: t.layer ?? layerOfTest(t.file, t.fullName),
          status: t.status,
          report: r.path,
        })),
    );
    const passed = tests.filter((t) => t.status === 'passed');
    const failed = tests.filter((t) => t.status === 'failed');
    const observed = LAYERS.filter((l) => passed.some((t) => t.layer === l));
    const missingLayers = entry.layers.filter((l) => !observed.includes(l));

    const artifacts: AcArtifact[] = entry.evidenceFiles.map((file) => {
      const stat = files(file);
      const present = stat !== undefined && stat.bytes > 0;
      const viaEntry = entries.some(
        (e) => e.acId === entry.acId && e.artifact === file,
      );
      const viaBuilder = generated.has(file);
      return {
        file,
        present,
        ...(stat ? { bytes: stat.bytes, sha256: stat.sha256 } : {}),
        provenance: viaEntry ? 'entry' : viaBuilder ? 'builder' : 'none',
      };
    });
    const badArtifacts = artifacts.filter(
      (a) => !a.present || a.provenance === 'none',
    );

    const waiver = waivers.find((w) => w.acId === entry.acId);
    let status: AcStatus;
    let reason: string;
    if (failed.length) {
      status = 'FAILED';
      reason = `failing test(s): ${failed.map((t) => t.fullName).join('; ')}`;
    } else if (waiver) {
      status = 'WAIVED';
      reason = `waived: ${waiver.reason} (approved by ${waiver.approvedBy} on ${waiver.date})`;
    } else if (missingLayers.length === 0 && entry.layers.length > 0) {
      if (badArtifacts.length) {
        status = 'NOT VERIFIED';
        reason = `evidence missing: ${badArtifacts.map((a) => a.file).join(', ')} (not present, empty, or without provenance)`;
      } else if (scan.status !== 'clean') {
        status = 'NOT VERIFIED';
        reason = `secret scan ${scan.status}: evidence cannot be trusted until the scan is clean`;
      } else {
        status = 'DONE';
        reason = `all required layers passed (${entry.layers.join(', ')}) with evidence`;
      }
    } else if (passed.length > 0) {
      status = 'NOT VERIFIED';
      reason = `required layer(s) outstanding: ${missingLayers.join(', ')}; observed: ${observed.join(', ') || 'none'}`;
    } else if (entry.blockedReason) {
      status = 'BLOCKED';
      reason = `blocked: ${entry.blockedReason}`;
    } else {
      status = 'NOT RUN';
      reason =
        `no passing test result for the required layer(s): ${entry.layers.join(', ')}` +
        (entry.needsEnvironment
          ? ' (needs a real database or browser environment)'
          : '');
    }

    acs.push({
      acId: entry.acId,
      section: entry.section,
      requirement: entry.requirement,
      requiredLayers: entry.layers,
      observedLayers: observed,
      needsEnvironment: entry.needsEnvironment,
      status,
      reason,
      tests,
      artifacts,
      ...(waiver && status === 'WAIVED' ? { waiver } : {}),
    });

    const first = passed[0] ?? tests[0];
    const firstReport = first
      ? reports.find((r) => r.path === first.report)
      : undefined;
    for (const artifact of artifacts) {
      if (!artifact.sha256) continue;
      const provenance = entries.find(
        (e) => e.acId === entry.acId && e.artifact === artifact.file,
      );
      records.push({
        acId: entry.acId,
        artifact: artifact.file,
        sha256: artifact.sha256,
        repo: meta.repo,
        commit: meta.commit,
        testName: provenance?.testName ?? first?.fullName ?? '',
        command: firstReport?.command ?? '',
        timestamp: provenance?.timestamp ?? meta.generatedAt,
        environment: provenance?.environment ?? firstReport?.environment ?? '',
        actualResult:
          provenance?.actualResult ??
          `${passed.length} passed, ${failed.length} failed (layers: ${observed.join(', ') || 'none'})`,
        status,
      });
    }
  }

  const byStatus = Object.fromEntries(
    STATUSES.map((s) => [s, acs.filter((a) => a.status === s).length]),
  ) as Record<AcStatus, number>;
  return {
    meta,
    scan,
    reports: reports.map((r) => ({
      path: r.path,
      sha256: r.sha256,
      command: r.command,
      environment: r.environment,
      tests: r.results.length,
    })),
    summary: { total: acs.length, outOfScope, byStatus },
    acs,
    records,
  };
}

/** Converts a vitest `--reporter=json` document into per-test results with repo-relative paths and layers. */
export function parseVitestReport(
  json: unknown,
  info: {
    path: string;
    sha256: string;
    command: string;
    environment: EvidenceEnvironment;
    repoRoot: string;
  },
): ReportInput {
  const doc = json as {
    testResults?: {
      name?: string;
      assertionResults?: { fullName?: string; status?: string }[];
    }[];
  };
  if (!doc || !Array.isArray(doc.testResults))
    throw new Error('not a vitest JSON report (no testResults)');
  const root = info.repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const results: TestResult[] = [];
  for (const file of doc.testResults) {
    const normalised = (file.name ?? '').replace(/\\/g, '/');
    const relative = normalised.startsWith(`${root}/`)
      ? normalised.slice(root.length + 1)
      : normalised;
    for (const a of file.assertionResults ?? []) {
      const fullName = a.fullName ?? '';
      results.push({
        file: relative,
        fullName,
        status: a.status ?? 'unknown',
        layer: layerOfTest(relative, fullName),
      });
    }
  }
  return {
    path: info.path,
    sha256: info.sha256,
    command: info.command,
    environment: info.environment,
    results,
  };
}

/** The per-AC "extract of test output": which tests ran for the criterion, where, and what each result was. */
export function renderTestExtract(
  acId: string,
  reports: ReportInput[],
  meta: RunMeta,
): string {
  const lines = [
    `Test results for ${acId}`,
    `repository: ${meta.repo}  branch: ${meta.branch}  commit: ${meta.commit}`,
  ];
  for (const r of reports) {
    const mine = r.results.filter((t) => acTagsOf(t.fullName).includes(acId));
    if (!mine.length) continue;
    lines.push(
      '',
      `command: ${r.command}`,
      `report: ${r.path} (sha256 ${r.sha256})`,
      `environment: ${r.environment}`,
    );
    for (const t of mine)
      lines.push(
        `  [${t.layer ?? '?'}] ${t.status.padEnd(7)} ${t.fullName}  (${t.file})`,
      );
  }
  return `${lines.join('\n')}\n`;
}

/** Extract files to write: every criterion whose evidence includes `test-results/<AC>.txt` and which has a test result. */
export function extractsToWrite(
  registry: AcRegistryEntry[],
  reports: ReportInput[],
  meta: RunMeta,
): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const entry of registry) {
    if (!inScope(entry, meta.scope)) continue;
    const file = `test-results/${entry.acId}.txt`;
    if (!entry.evidenceFiles.includes(file)) continue;
    const ran = reports.some((r) =>
      r.results.some(
        (t) =>
          acTagsOf(t.fullName).includes(entry.acId) &&
          (t.status === 'passed' || t.status === 'failed'),
      ),
    );
    if (ran)
      out.push({ file, content: renderTestExtract(entry.acId, reports, meta) });
  }
  return out;
}
