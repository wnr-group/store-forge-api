/**
 * Converts Playwright JSON reports into the Vitest JSON shape the manifest builder reads, so browser tests count as the PW layer.
 *
 *   npx tsx scripts/qa-evidence/playwright-to-vitest.ts --out <vitest-shaped.json> --root <frontend repo> <playwright.json>...
 *
 * - Each test's name carries the acceptance criteria it covers (from its `AC` annotation, space separated) and `[layer:PW]`.
 * - Several passes (for example one with the API's encryption key and one without) are merged by test name: a test is `passed`
 *   if any pass passed it, `failed` if any failed it, and `skipped` only if no pass ran it. A skip never counts as a pass.
 * - The statuses are Playwright's own; nothing is inferred and nothing is added.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type PwTest = {
  annotations?: { type: string; description?: string }[];
  results?: { status: string }[];
  status?: string;
};
type PwSpec = { title: string; file?: string; tests?: PwTest[] };
type PwSuite = {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag('out');
const root = (flag('root') ?? process.cwd())
  .replace(/\\/g, '/')
  .replace(/\/$/, '');
const inputs = args.filter(
  (a, i) =>
    !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--root',
);
if (!out || inputs.length === 0) {
  console.error(
    'usage: playwright-to-vitest.ts --out <file> --root <repo> <playwright.json>...',
  );
  process.exit(2);
}

const rank: Record<string, number> = { passed: 3, failed: 2, skipped: 1 };
const merged = new Map<string, { file: string; status: string }>();

const statusOf = (t: PwTest): string => {
  const last =
    t.results?.[t.results.length - 1]?.status ?? t.status ?? 'unknown';
  if (last === 'passed') return 'passed';
  if (last === 'skipped' || t.status === 'skipped') return 'skipped';
  return 'failed'; // failed, timedOut, interrupted
};

const visit = (suite: PwSuite, titles: string[], file: string) => {
  const here =
    suite.title && suite.title !== file ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const acs = (test.annotations ?? [])
        .filter((a) => a.type === 'AC')
        .map((a) => a.description ?? '')
        .join(' ')
        .trim();
      const fullName = `${[...here, spec.title].join(' > ')}${acs ? ` ${acs}` : ''} [layer:PW]`;
      const status = statusOf(test);
      const before = merged.get(fullName);
      // failed beats passed on purpose: a test that failed in any pass is reported failed.
      const keep =
        !before ||
        (status === 'failed'
          ? true
          : before.status === 'failed'
            ? false
            : (rank[status] ?? 0) > (rank[before.status] ?? 0));
      if (keep)
        merged.set(fullName, { file: `${root}/${spec.file ?? file}`, status });
    }
  }
  for (const child of suite.suites ?? []) visit(child, here, file);
};

for (const input of inputs) {
  const doc = JSON.parse(readFileSync(input, 'utf8')) as { suites?: PwSuite[] };
  for (const suite of doc.suites ?? [])
    visit(suite, [], suite.file ?? suite.title);
}

const byFile = new Map<string, { fullName: string; status: string }[]>();
for (const [fullName, v] of merged) {
  const list = byFile.get(v.file) ?? [];
  list.push({ fullName, status: v.status });
  byFile.set(v.file, list);
}
const count = (s: string) =>
  [...merged.values()].filter((v) => v.status === s).length;
writeFileSync(
  out,
  `${JSON.stringify(
    {
      numTotalTests: merged.size,
      numPassedTests: count('passed'),
      numFailedTests: count('failed'),
      numPendingTests: count('skipped'),
      testResults: [...byFile].map(([name, assertionResults]) => ({
        name,
        assertionResults,
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `converted ${merged.size} tests (${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped) -> ${out}`,
);
