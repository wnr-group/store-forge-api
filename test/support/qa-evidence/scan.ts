import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secret-leakage scan for QA evidence. A run uses synthetic secrets generated for that run and passes them in the
 * environment (never written to disk); every file under the evidence folder (logs, API captures, reports, screenshots and
 * any other binary) is then searched for each of them in the forms a leak usually takes. The result names the file, the
 * sentinel's position in the list and the form it appeared in, and never contains a sentinel value.
 */

export type LeakForm = 'raw' | 'url' | 'base64';

export interface ScanFinding {
  /** Forward-slash path relative to the scanned root. */
  file: string;
  sentinelIndex: number;
  form: LeakForm;
}

export interface ScanResult {
  scannedFiles: number;
  scannedBytes: number;
  sentinelCount: number;
  findings: ScanFinding[];
}

const MIN_SENTINEL_LENGTH = 8;

/** Parses `QA_SENTINELS` (a JSON array of strings). Errors never repeat a sentinel. */
export function loadSentinels(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const raw = env.QA_SENTINELS;
  if (raw === undefined || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('QA_SENTINELS must be a JSON array of strings');
  }
  if (!Array.isArray(parsed))
    throw new Error('QA_SENTINELS must be a JSON array of strings');
  return parsed.map((value) => {
    if (typeof value !== 'string')
      throw new Error('every QA_SENTINELS entry must be a string');
    if (value.length < MIN_SENTINEL_LENGTH)
      throw new Error(
        `every QA_SENTINELS entry must be at least ${MIN_SENTINEL_LENGTH} characters`,
      );
    return value;
  });
}

/**
 * Base64 of `value` as it appears when embedded at any of the three possible byte offsets inside a larger encoded blob:
 * the characters that mix in neighbouring bytes are trimmed, leaving the stable middle.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms = new Set<string>([bytes.toString('base64')]);
  for (const offset of [0, 1, 2]) {
    let encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
      'base64',
    );
    encoded = encoded.slice(Math.ceil((offset * 8) / 6));
    if (encoded.endsWith('='))
      encoded = encoded.replace(/=+$/, '').slice(0, -1);
    if (encoded.length >= 8) forms.add(encoded);
  }
  return [...forms];
}

function variantsOf(value: string): { form: LeakForm; text: string }[] {
  return [
    { form: 'raw' as const, text: value },
    { form: 'url' as const, text: encodeURIComponent(value) },
    ...base64Forms(value).map((text) => ({ form: 'base64' as const, text })),
  ];
}

/** Every distinct string a sentinel is searched for. */
export function sentinelVariants(value: string): string[] {
  return [...new Set(variantsOf(value).map((v) => v.text))];
}

/** The first sentinel found in `content`, if any. Used to vet a single artifact before it is written. */
export function findSentinel(
  content: Buffer | string,
  sentinels: readonly string[],
): { sentinelIndex: number; form: LeakForm } | undefined {
  const bytes =
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  for (const [sentinelIndex, sentinel] of sentinels.entries()) {
    const hit = variantsOf(sentinel).find((v) =>
      bytes.includes(Buffer.from(v.text, 'utf8')),
    );
    if (hit) return { sentinelIndex, form: hit.form };
  }
  return undefined;
}

function* filesUnder(
  dir: string,
  rootLength: number,
): Generator<{ abs: string; rel: string }> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(abs, rootLength);
    else if (entry.isFile())
      yield { abs, rel: abs.slice(rootLength + 1).replace(/\\/g, '/') };
  }
}

/** Throws when there is nothing to search for, so an unset sentinel list can never be mistaken for a clean scan. */
export function scanTree(
  root: string,
  sentinels: readonly string[],
): ScanResult {
  if (sentinels.length === 0)
    throw new Error(
      'no sentinels were provided, so nothing could be scanned for',
    );
  if (!existsSync(root)) throw new Error('the folder to scan does not exist');

  const variants = sentinels.map((s) =>
    variantsOf(s).map((v) => ({
      form: v.form,
      needle: Buffer.from(v.text, 'utf8'),
    })),
  );
  const findings: ScanFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const { abs, rel } of filesUnder(root, root.length)) {
    const content = readFileSync(abs);
    scannedFiles += 1;
    scannedBytes += content.length;
    variants.forEach((forms, sentinelIndex) => {
      const hit = forms.find((v) => content.includes(v.needle));
      if (hit) findings.push({ file: rel, sentinelIndex, form: hit.form });
    });
  }
  return {
    scannedFiles,
    scannedBytes,
    sentinelCount: sentinels.length,
    findings,
  };
}
