import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Layer } from './layers.js';
import { findSentinel, loadSentinels } from './scan.js';

/**
 * Writes QA evidence. Evidence is produced only by an executed test, only AFTER its assertion passed, and only when a run
 * is explicitly an evidence run (`QA_EVIDENCE=1`), so ordinary test runs never create artifacts. Every artifact is vetted
 * against the run's leak sentinels before it touches the disk, and each one gets a provenance entry that the manifest
 * builder later requires, so a file somebody dropped into the folder by hand can never count as evidence.
 */

export const EVIDENCE_FOLDERS = [
  'screenshots',
  'playwright-report',
  'test-results',
  'api-evidence',
  'database-evidence',
  'logs',
  'summary',
] as const;
export type EvidenceFolder = (typeof EVIDENCE_FOLDERS)[number];

export type EvidenceEnvironment = 'unit' | 'pglite' | 'local-stack' | 'hosted';

/** Raised when an artifact contains a sentinel. Names the position and form only, never the value. */
export class EvidenceLeakError extends Error {
  constructor(sentinelIndex: number, form: string) {
    super(
      `evidence contains leak sentinel #${sentinelIndex} (${form}); nothing was written`,
    );
    this.name = 'EvidenceLeakError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export const evidenceRoot = (env: Env = process.env): string =>
  env.QA_EVIDENCE_DIR ??
  join(process.cwd(), 'artifacts', 'qa-evidence', 'razorpay-configuration');

export function ensureEvidenceStructure(root: string): void {
  for (const folder of EVIDENCE_FOLDERS)
    mkdirSync(join(root, folder), { recursive: true });
}

export interface CaptureOptions {
  acId: string;
  folder: EvidenceFolder;
  /** Must start with the criterion id. Defaults to `<acId>.json`, `.txt` or `.bin` by content type. */
  fileName?: string;
  layer: Layer;
  environment: EvidenceEnvironment;
  /** What was actually observed, in a sentence. */
  actualResult: string;
  testName?: string;
  /** The expectations that prove the behaviour. Runs first; if it throws, nothing is captured. */
  assert: () => void | Promise<void>;
  /** The artifact. Only called when the assertion passed and this is an evidence run. */
  content: () => string | Buffer | object;
}

const AC_ID = /^AC-[A-Z]+-\d+[a-z]?$/;

function currentTest(): { name: string; file: string } {
  const state = (
    globalThis as {
      expect?: {
        getState?: () => { currentTestName?: string; testPath?: string };
      };
    }
  ).expect?.getState?.();
  return {
    name: state?.currentTestName ?? '',
    file: (state?.testPath ?? '').replace(/\\/g, '/'),
  };
}

function defaultName(acId: string, content: string | Buffer | object): string {
  if (typeof content === 'string') return `${acId}.txt`;
  return Buffer.isBuffer(content) ? `${acId}.bin` : `${acId}.json`;
}

function checkFileName(acId: string, fileName: string): void {
  if (
    fileName === '' ||
    !fileName.startsWith(acId) ||
    /[\\/]/.test(fileName) ||
    fileName.includes('..')
  )
    throw new Error(
      `invalid evidence file name for ${acId}: it must start with the AC id and stay in its folder`,
    );
}

export async function captureEvidence(
  options: CaptureOptions,
  env: Env = process.env,
): Promise<{ written: false } | { written: true; file: string }> {
  if (!AC_ID.test(options.acId)) throw new Error('invalid AC id');
  if (options.fileName !== undefined)
    checkFileName(options.acId, options.fileName);

  await options.assert();
  if (env.QA_EVIDENCE !== '1') return { written: false };

  const sentinels = loadSentinels(env);
  if (sentinels.length === 0)
    throw new Error(
      'QA_SENTINELS is required for an evidence run (QA_EVIDENCE=1): no evidence is written without leak protection',
    );

  const produced = options.content();
  const fileName = options.fileName ?? defaultName(options.acId, produced);
  checkFileName(options.acId, fileName);
  const bytes =
    typeof produced === 'string'
      ? Buffer.from(produced, 'utf8')
      : Buffer.isBuffer(produced)
        ? produced
        : Buffer.from(`${JSON.stringify(produced, null, 2)}\n`, 'utf8');

  const test = currentTest();
  const entry = {
    acId: options.acId,
    artifact: `${options.folder}/${fileName}`,
    // Binds this entry to exactly these bytes: a replaced file no longer matches and so loses its provenance.
    sha256: createHash('sha256').update(bytes).digest('hex'),
    testName: options.testName ?? test.name,
    testFile: test.file,
    layer: options.layer,
    environment: options.environment,
    actualResult: options.actualResult,
    timestamp: new Date().toISOString(),
  };
  const line = `${JSON.stringify(entry)}\n`;

  for (const candidate of [bytes, Buffer.from(line, 'utf8')]) {
    const hit = findSentinel(candidate, sentinels);
    if (hit) throw new EvidenceLeakError(hit.sentinelIndex, hit.form);
  }

  const root = evidenceRoot(env);
  ensureEvidenceStructure(root);
  writeFileSync(join(root, options.folder, fileName), bytes);
  appendFileSync(join(root, 'summary', 'evidence-entries.jsonl'), line);
  return { written: true, file: entry.artifact };
}
