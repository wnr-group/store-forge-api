/**
 * Generates `test/support/qa-evidence/ac-registry.json` from the frozen plan's traceability matrix, so the manifest builder
 * judges every criterion against exactly the layers, evidence files and blockers the plan states (nothing is retyped).
 *
 *   npx tsx scripts/qa-evidence/build-registry.ts --plan <plan.md> [--out <registry.json>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parsePlanMatrix } from '../../test/support/qa-evidence/registry.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const plan = arg('plan');
if (!plan) {
  console.error(
    'usage: build-registry.ts --plan <plan.md> [--out <registry.json>]',
  );
  process.exit(2);
}
const out = arg('out') ?? 'test/support/qa-evidence/ac-registry.json';

const markdown = readFileSync(plan, 'utf8');
const entries = parsePlanMatrix(markdown);
const ids = entries.map((e) => e.acId);
if (new Set(ids).size !== ids.length) {
  console.error('duplicate acceptance-criterion ids in the plan matrix');
  process.exit(1);
}
const registry = {
  source: basename(plan),
  sourceSha256: createHash('sha256').update(markdown).digest('hex'),
  count: entries.length,
  entries,
};
writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`);
console.log(
  `wrote ${entries.length} acceptance criteria to ${out} (plan sha256 ${registry.sourceSha256.slice(0, 12)}...)`,
);
