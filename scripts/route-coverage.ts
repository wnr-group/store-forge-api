/**
 * `npm run coverage:routes` - runs the e2e suite while recording every route the tests really call, then compares
 * that with every route the application declares (the OpenAPI document). A route counts as TESTED when at least one
 * request reached it and got a 2xx answer; routes that were only ever refused (401/403/4xx) are listed separately.
 * Needs the migrations of the owning repository (STOREFORGE_MIGRATIONS_DIR), like the e2e suite itself.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_ENV } from '../test/support/test-env.js';

Object.assign(process.env, TEST_ENV, { THROTTLE_LIMIT: '100000' });

const dir = mkdtempSync(join(tmpdir(), 'route-coverage-'));
const hitsFile = join(dir, 'hits.log');
const declaredFile = join(dir, 'declared.txt');
writeFileSync(hitsFile, '');

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--config', './vitest.config.e2e.ts'],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ROUTE_HITS_FILE: hitsFile,
      ROUTE_DECLARED_FILE: declaredFile,
    },
  },
);

const declared = existsSync(declaredFile)
  ? readFileSync(declaredFile, 'utf8').split('\n').filter(Boolean)
  : [];

const hits = existsSync(hitsFile)
  ? readFileSync(hitsFile, 'utf8').split('\n').filter(Boolean)
  : [];
const ok = new Set<string>();
const any = new Set<string>();
for (const line of hits) {
  const [method, path, status] = line.split(' ');
  const key = `${method} ${path}`;
  any.add(key);
  if (status.startsWith('2')) ok.add(key);
}

const untested = declared.filter((d) => !ok.has(d));
console.log('\n=== Route coverage ===');
console.log(`Declared routes:           ${declared.length}`);
console.log(
  `Reached by a test (any):   ${declared.filter((d) => any.has(d)).length}`,
);
console.log(
  `Succeeded in a test (2xx): ${declared.filter((d) => ok.has(d)).length}`,
);
if (untested.length)
  console.log(`Never succeeded in a test:\n - ${untested.join('\n - ')}`);

rmSync(dir, { recursive: true, force: true });
process.exitCode = run.status !== 0 ? 1 : untested.length ? 1 : 0;
