/**
 * Builds the evidence manifest (`summary/manifest.json`) from saved test reports, the registry and the evidence folder.
 *
 *   npx tsx scripts/qa-evidence/build-manifest.ts --dir <evidence root> --scope api|frontend --repo-root <repo> \
 *     --report "<report path relative to --dir>|<exact command>|<unit|pglite|local-stack|hosted>" [--report ...] \
 *     [--extracts-only] [--waivers <waivers.json>] [--registry <registry.json>]
 *
 * Order of a run: tests produce evidence and JSON reports -> `--extracts-only` writes the per-AC test extracts ->
 * scan-secrets scans the whole folder -> this script (without --extracts-only) builds the manifest. A criterion is DONE
 * only when the manifest builder can prove it; see test/support/qa-evidence/manifest.ts for the rules.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildManifest,
  extractsToWrite,
  parseVitestReport,
  type EvidenceEntry,
  type ReportInput,
  type RunMeta,
  type Waiver,
} from '../../test/support/qa-evidence/manifest.js';
import { digestTree } from '../../test/support/qa-evidence/scan.js';
import type { AcRegistryEntry } from '../../test/support/qa-evidence/registry.js';
import type { EvidenceEnvironment } from '../../test/support/qa-evidence/writer.js';

const args = process.argv.slice(2);
const one = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const many = (name: string): string[] =>
  args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? ''] : []));

const dir = one('dir');
const scope = one('scope');
// Absolute, so file paths in reports are made repository-relative whatever form the caller used.
const repoRoot = resolve(one('repo-root') ?? process.cwd());
if (!dir || (scope !== 'api' && scope !== 'frontend')) {
  console.error(
    'usage: build-manifest.ts --dir <evidence root> --scope api|frontend --report "path|command|environment" ... [--baseline "path|command|environment|baselineRepoRoot" ...]',
  );
  process.exit(2);
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const git = (...a: string[]) =>
  execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' }).trim();

const registry = (
  JSON.parse(
    readFileSync(
      one('registry') ?? 'test/support/qa-evidence/ac-registry.json',
      'utf8',
    ),
  ) as {
    entries: AcRegistryEntry[];
  }
).entries;

/** "path|command|environment[|repoRoot]": the path is relative to --dir; repoRoot defaults to this repository. */
const readReport = (spec: string): ReportInput => {
  const [path = '', command = '', environment = '', root] = spec.split('|');
  const bytes = readFileSync(join(dir, path));
  return parseVitestReport(JSON.parse(bytes.toString('utf8')), {
    path,
    sha256: sha256(bytes),
    command,
    environment: environment as EvidenceEnvironment,
    repoRoot: root ? resolve(root) : repoRoot,
  });
};
const reports: ReportInput[] = many('report').map(readReport);
/** Reports of the same suites at the baseline commit; their repoRoot is the baseline worktree. */
const baselines: ReportInput[] = many('baseline').map(readReport);

const meta: RunMeta = {
  repo: scope === 'api' ? 'store-forge-api' : 'store-forge',
  scope,
  branch: git('branch', '--show-current'),
  commit: git('rev-parse', 'HEAD'),
  // Tracked modifications only: the evidence folder and other untracked files do not make a run "dirty".
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  node: process.version,
  generatedAt: new Date().toISOString(),
};

const generated: string[] = [];
const extracts = extractsToWrite(registry, reports, meta, baselines);
const extractsOnly = args.includes('--extracts-only');
for (const { file, content } of extracts) {
  // Files are written only in the extracts step, BEFORE the secret scan. The manifest step re-derives the same list for
  // provenance but never rewrites a file, so nothing can change after the scan that vouches for the folder.
  if (extractsOnly) {
    mkdirSync(join(dir, 'test-results'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  generated.push(file);
}
if (extractsOnly) {
  console.log(`wrote ${extracts.length} per-AC test extract(s)`);
  process.exit(0);
}

const entriesFile = join(dir, 'summary', 'evidence-entries.jsonl');
const entries: EvidenceEntry[] = existsSync(entriesFile)
  ? readFileSync(entriesFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EvidenceEntry)
  : [];

const scanFile = join(dir, 'summary', 'secret-scan.json');
const scan = existsSync(scanFile)
  ? (() => {
      const s = JSON.parse(readFileSync(scanFile, 'utf8')) as {
        scannedFiles: number;
        filesDigest?: string;
        findings: unknown[];
      };
      // The result only counts for the files it scanned: a changed, added or removed file makes it stale.
      return {
        status: s.findings.length
          ? ('dirty' as const)
          : s.filesDigest === digestTree(dir)
            ? ('clean' as const)
            : ('stale' as const),
        scannedFiles: s.scannedFiles,
      };
    })()
  : { status: 'missing' as const, scannedFiles: 0 };

const waiversFile = one('waivers');
const waivers: Waiver[] = waiversFile
  ? (JSON.parse(readFileSync(waiversFile, 'utf8')) as Waiver[])
  : [];

const manifest = buildManifest({
  registry,
  reports,
  baselines,
  entries,
  generated,
  scan,
  waivers,
  meta,
  files: (rel) => {
    const p = join(dir, rel);
    return existsSync(p) && statSync(p).isFile()
      ? { bytes: statSync(p).size, sha256: sha256(readFileSync(p)) }
      : undefined;
  },
});

mkdirSync(join(dir, 'summary'), { recursive: true });
writeFileSync(
  join(dir, 'summary', 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `manifest: ${manifest.summary.total} criteria in scope (${manifest.summary.outOfScope} belong to the other repository)`,
);
for (const [status, n] of Object.entries(manifest.summary.byStatus))
  console.log(`  ${status.padEnd(13)} ${n}`);
console.log(
  `  secret scan: ${scan.status} (${scan.scannedFiles} files)  commit ${meta.commit.slice(0, 7)}${meta.dirty ? ' (tracked changes present)' : ''}`,
);
