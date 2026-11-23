/**
 * Converts Playwright JSON reports into the Vitest JSON shape the manifest builder reads, so browser tests count as the PW layer.
 *
 *   npx tsx scripts/qa-evidence/playwright-to-vitest.ts --out <vitest-shaped.json> --root <frontend repo> <playwright.json>...
 *
 * - Each test's name carries the acceptance criteria it covers (from its `AC` annotation, space separated) and `[layer:PW]`.
 * - Several reports (for example a pass with the API's encryption key and one without) are merged by test name, oldest first: the
 *   latest report that actually ran a test decides its result, and a skip never replaces a result or counts as a pass.
 * - The statuses are Playwright's own; nothing is inferred and nothing is added.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type PwTest = {
  annotations?: { type: string; description?: string }[];
  results?: { status: string }[];
  status?: string;
  projectName?: string;
  projectId?: string;
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

/** Each project's latest executed result per test name, kept across reports; the projects are aggregated only at the end. */
const projects = new Map<
  string,
  Map<string, { file: string; status: string }>
>();

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
      const project = test.projectName ?? test.projectId ?? '';
      const status = statusOf(test);
      const perProject = projects.get(fullName) ?? new Map();
      projects.set(fullName, perProject);
      // Inputs are given oldest first and the latest run that actually EXECUTED a test (per project) decides its result: a
      // failure that was fixed and re-run is superseded, and a skip never replaces a result.
      if (!perProject.has(project) || status !== 'skipped')
        perProject.set(project, {
          file: `${root}/${spec.file ?? file}`,
          status,
        });
    }
  }
  for (const child of suite.suites ?? []) visit(child, here, file);
};

for (const input of inputs) {
  const doc = JSON.parse(readFileSync(input, 'utf8')) as { suites?: PwSuite[] };
  for (const suite of doc.suites ?? [])
    visit(suite, [], suite.file ?? suite.title);
}

/** A test is only as good as its worst project: any failing project fails it, and it passes only if some project passed. */
const merged = new Map<string, { file: string; status: string }>();
for (const [fullName, perProject] of projects) {
  const results = [...perProject.values()];
  const status = results.some((r) => r.status === 'failed')
    ? 'failed'
    : results.some((r) => r.status === 'passed')
      ? 'passed'
      : 'skipped';
  merged.set(fullName, { file: results[0]?.file ?? '', status });
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
