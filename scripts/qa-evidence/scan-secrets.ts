/**
 * Scans an evidence folder for this run's leak sentinels and records the outcome in `summary/secret-scan.json`.
 * The sentinels (synthetic secrets generated for the run) come from the environment as a JSON array in QA_SENTINELS and
 * are never written anywhere. The result lists files and sentinel positions only. Exits 1 on any finding or error.
 *
 *   QA_SENTINELS='["..."]' npx tsx scripts/qa-evidence/scan-secrets.ts --dir <evidence root>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSentinels,
  scanTree,
} from '../../test/support/qa-evidence/scan.js';
import { evidenceRoot } from '../../test/support/qa-evidence/writer.js';

const i = process.argv.indexOf('--dir');
const root = i >= 0 ? (process.argv[i + 1] ?? '') : evidenceRoot();

try {
  const result = scanTree(root, loadSentinels());
  mkdirSync(join(root, 'summary'), { recursive: true });
  writeFileSync(
    join(root, 'summary', 'secret-scan.json'),
    `${JSON.stringify({ scannedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
  );
  console.log(
    `secret scan: ${result.scannedFiles} files, ${result.scannedBytes} bytes, ${result.sentinelCount} sentinel(s), ${result.findings.length} finding(s)`,
  );
  for (const f of result.findings)
    console.error(`LEAK: ${f.file} (sentinel #${f.sentinelIndex}, ${f.form})`);
  process.exit(result.findings.length ? 1 : 0);
} catch (error) {
  console.error(`secret scan could not run: ${(error as Error).message}`);
  process.exit(1);
}
