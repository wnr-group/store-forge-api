/**
 * Prettier check limited to the TypeScript files (src/, test/) that a change adds, copies, modifies or renames, so formatting
 * debt that already sits elsewhere cannot fail an unrelated change. `npm run format:check` still checks the whole repository.
 *
 *   FORMAT_BASE=origin/main node scripts/format-check-changed.mjs      (or pass the base ref as the first argument)
 *
 * The base must resolve: a missing ref is an error, never a silent pass. An all-zero SHA (the "before" of a push that creates a
 * branch) falls back to origin/main. Changed files are those since the merge base of the base and HEAD (`base...HEAD`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

let base = process.argv[2] ?? process.env.FORMAT_BASE ?? 'origin/main';
if (/^0+$/.test(base)) base = 'origin/main';

try {
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
} catch {
  console.error(
    `format check: cannot resolve the base "${base}". Fetch it (CI checks out with fetch-depth: 0) or set FORMAT_BASE.`,
  );
  process.exit(2);
}

const files = git('diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`)
  .split('\n')
  .map((f) => f.trim())
  .filter((f) => /^(src|test)\/.+\.ts$/.test(f) && existsSync(f));

if (files.length === 0) {
  console.log(`format check: no changed src/test TypeScript files since ${base}`);
  process.exit(0);
}

console.log(`format check: ${files.length} changed file(s) since ${base}`);
const prettier = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');
let failed = false;
for (let i = 0; i < files.length; i += 100) {
  const run = spawnSync(
    process.execPath,
    [prettier, '--check', ...files.slice(i, i + 100)],
    { stdio: 'inherit' },
  );
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
