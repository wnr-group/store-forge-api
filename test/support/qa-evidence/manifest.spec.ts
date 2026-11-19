import type { Layer } from './layers.js';
import {
  buildManifest,
  extractsToWrite,
  parseVitestReport,
  renderTestExtract,
  type BuildInput,
  type EvidenceEntry,
  type ReportInput,
  type TestResult,
} from './manifest.js';
import type { AcRegistryEntry } from './registry.js';

const META = {
  repo: 'store-forge-api',
  scope: 'api' as const,
  branch: 'feat/razorpay-config',
  commit: 'abc1234def5678',
  dirty: false,
  node: 'v24.18.0',
  generatedAt: '2026-11-19T10:00:00.000Z',
};

const ac = (
  acId: string,
  over: Partial<AcRegistryEntry> = {},
): AcRegistryEntry => ({
  acId,
  section: '7.2',
  requirement: `requirement of ${acId}`,
  location: 'somewhere',
  method: 'PG A `x`',
  layers: ['PG'],
  preconditions: 'P2',
  expected: 'it works',
  evidenceFiles: [`database-evidence/${acId}.json`],
  repo: 'api',
  needsEnvironment: false,
  blockedReason: undefined,
  initialStatus: 'NOT RUN',
  ...over,
});

const test = (
  fullName: string,
  status: TestResult['status'],
  layer: Layer,
  file = 'test/x.e2e-spec.ts',
): TestResult => ({
  fullName,
  status,
  layer,
  file,
});

const report = (
  results: TestResult[],
  over: Partial<ReportInput> = {},
): ReportInput => ({
  path: 'test-results/api-e2e.json',
  sha256: 'r'.repeat(64),
  command: 'npm run test:e2e',
  environment: 'pglite',
  results,
  ...over,
});

const entry = (
  acId: string,
  artifact: string,
  over: Partial<EvidenceEntry> = {},
): EvidenceEntry => ({
  acId,
  artifact,
  testName: `captured ${acId}`,
  testFile: 'test/x.e2e-spec.ts',
  layer: 'PG',
  environment: 'pglite',
  actualResult: 'observed it',
  timestamp: '2026-11-19T09:59:00.000Z',
  ...over,
});

const clean = { status: 'clean' as const, scannedFiles: 12 };
const present =
  (files: Record<string, number> = {}) =>
  (rel: string) =>
    rel in files ? { bytes: files[rel] ?? 0, sha256: `sha-${rel}` } : undefined;

function build(over: Partial<BuildInput> & Pick<BuildInput, 'registry'>) {
  return buildManifest({
    reports: [],
    entries: [],
    files: present(),
    scan: clean,
    waivers: [],
    meta: META,
    ...over,
  });
}
const statusOf = (m: ReturnType<typeof build>, id: string) =>
  m.acs.find((a) => a.acId === id);

describe('status decisions', () => {
  it('a criterion with no test result is NOT RUN', () => {
    const m = build({ registry: [ac('AC-DB-01')] });
    expect(statusOf(m, 'AC-DB-01')).toMatchObject({ status: 'NOT RUN' });
  });

  it('a row the plan marks blocked stays BLOCKED, with its reason', () => {
    const m = build({
      registry: [
        ac('AC-API-07', {
          blockedReason: 'secret rule pending',
          initialStatus: 'BLOCKED',
        }),
      ],
    });
    expect(statusOf(m, 'AC-API-07')).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringContaining('secret rule pending'),
    });
  });

  it('a row that needs an environment says so when nothing ran', () => {
    const m = build({
      registry: [
        ac('AC-UI-01', { layers: ['PW'], needsEnvironment: true, repo: 'api' }),
      ],
    });
    const r = statusOf(m, 'AC-UI-01');
    expect(r?.status).toBe('NOT RUN');
    expect(r?.reason).toMatch(/environment/i);
  });

  it('unit tests alone never complete a criterion that also needs the HTTP layer (NOT VERIFIED)', () => {
    const m = build({
      registry: [
        ac('AC-KEY-01', {
          layers: ['HTTP'],
          evidenceFiles: ['api-evidence/AC-KEY-01.json'],
        }),
      ],
      reports: [
        report([
          test(
            'loader fails closed (AC-KEY-01)',
            'passed',
            'U',
            'src/a.spec.ts',
          ),
        ]),
      ],
    });
    const r = statusOf(m, 'AC-KEY-01');
    expect(r?.status).toBe('NOT VERIFIED');
    expect(r?.reason).toMatch(/HTTP/);
    expect(r?.observedLayers).toEqual(['U']);
  });

  it('a multi-layer criterion with only one of its layers passing is NOT VERIFIED; with both it can be DONE', () => {
    const files = present({ 'test-results/AC-DB-06.txt': 40 });
    const registry = [
      ac('AC-DB-06', {
        layers: ['U', 'PG'],
        evidenceFiles: ['test-results/AC-DB-06.txt'],
      }),
    ];
    const half = build({
      registry,
      files,
      reports: [
        report([test('drift (AC-DB-06)', 'passed', 'U', 'src/a.spec.ts')]),
      ],
    });
    expect(statusOf(half, 'AC-DB-06')?.status).toBe('NOT VERIFIED');
    const both = build({
      registry,
      files,
      generated: ['test-results/AC-DB-06.txt'],
      reports: [
        report([
          test('drift (AC-DB-06)', 'passed', 'U', 'src/a.spec.ts'),
          test(
            'drift db (AC-DB-06)',
            'passed',
            'PG',
            'test/payments-database.e2e-spec.ts',
          ),
        ]),
      ],
    });
    expect(statusOf(both, 'AC-DB-06')?.status).toBe('DONE');
  });

  it('is DONE only when tests passed, the artifact exists with content and has a provenance entry, and the scan is clean', () => {
    const m = build({
      registry: [ac('AC-RLS-02')],
      reports: [
        report([test('secret columns denied (AC-RLS-02)', 'passed', 'PG')]),
      ],
      entries: [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
      files: present({ 'database-evidence/AC-RLS-02.json': 120 }),
    });
    expect(statusOf(m, 'AC-RLS-02')).toMatchObject({ status: 'DONE' });
  });

  it('a failing test makes the criterion FAILED even when other tests pass', () => {
    const m = build({
      registry: [ac('AC-RLS-02')],
      reports: [
        report([
          test('a (AC-RLS-02)', 'passed', 'PG'),
          test('b (AC-RLS-02)', 'failed', 'PG'),
        ]),
      ],
      entries: [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
      files: present({ 'database-evidence/AC-RLS-02.json': 120 }),
    });
    expect(statusOf(m, 'AC-RLS-02')).toMatchObject({
      status: 'FAILED',
      reason: expect.stringContaining('b (AC-RLS-02)'),
    });
  });

  it('skipped tests count as nothing', () => {
    const m = build({
      registry: [ac('AC-RLS-02')],
      reports: [report([test('a (AC-RLS-02)', 'skipped', 'PG')])],
    });
    expect(statusOf(m, 'AC-RLS-02')?.status).toBe('NOT RUN');
  });

  describe.each([
    [
      'the artifact is missing',
      {},
      [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
    ],
    [
      'the artifact is empty',
      { 'database-evidence/AC-RLS-02.json': 0 },
      [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
    ],
    [
      'the artifact has no provenance entry (created by hand)',
      { 'database-evidence/AC-RLS-02.json': 50 },
      [],
    ],
    [
      'the entry belongs to another criterion',
      { 'database-evidence/AC-RLS-02.json': 50 },
      [entry('AC-RLS-03', 'database-evidence/AC-RLS-02.json')],
    ],
  ])('when %s', (_label, files, entries) => {
    it('a passing test is not enough: NOT VERIFIED', () => {
      const m = build({
        registry: [ac('AC-RLS-02')],
        reports: [report([test('a (AC-RLS-02)', 'passed', 'PG')])],
        entries,
        files: present(files),
      });
      const r = statusOf(m, 'AC-RLS-02');
      expect(r?.status).toBe('NOT VERIFIED');
      expect(r?.reason).toMatch(/evidence/i);
    });
  });

  it.each(['dirty', 'missing'] as const)(
    'is never DONE when the secret scan is %s',
    (scanStatus) => {
      const m = build({
        registry: [ac('AC-RLS-02')],
        reports: [report([test('a (AC-RLS-02)', 'passed', 'PG')])],
        entries: [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
        files: present({ 'database-evidence/AC-RLS-02.json': 120 }),
        scan: { status: scanStatus, scannedFiles: 0 },
      });
      const r = statusOf(m, 'AC-RLS-02');
      expect(r?.status).toBe('NOT VERIFIED');
      expect(r?.reason).toMatch(/scan/i);
    },
  );

  it('accepts a per-AC test extract the builder itself generated in this run as its own provenance', () => {
    const registry = [
      ac('AC-ENC-01', {
        layers: ['U'],
        evidenceFiles: ['test-results/AC-ENC-01.txt'],
      }),
    ];
    const reports = [
      report([test('round trip (AC-ENC-01)', 'passed', 'U', 'src/a.spec.ts')]),
    ];
    const files = present({ 'test-results/AC-ENC-01.txt': 300 });
    const generated = build({
      registry,
      reports,
      files,
      generated: ['test-results/AC-ENC-01.txt'],
    });
    expect(statusOf(generated, 'AC-ENC-01')?.status).toBe('DONE');
    // The same file placed by hand, not generated by the builder, is not evidence.
    const byHand = build({ registry, reports, files });
    expect(statusOf(byHand, 'AC-ENC-01')?.status).toBe('NOT VERIFIED');
  });

  it('counts one test for every criterion it names', () => {
    const m = build({
      registry: [
        ac('AC-ENC-02', { layers: ['U'], evidenceFiles: [] }),
        ac('AC-ENC-03', { layers: ['U'], evidenceFiles: [] }),
      ],
      reports: [
        report([
          test('tamper (AC-ENC-02, AC-ENC-03)', 'passed', 'U', 'src/a.spec.ts'),
        ]),
      ],
    });
    expect(m.acs.map((a) => a.status)).toEqual(['DONE', 'DONE']);
  });

  it('a waiver gives WAIVED with its approver, but never hides a failure', () => {
    const waivers = [
      {
        acId: 'AC-UI-01',
        reason: 'no browser environment',
        approvedBy: '@Eshwar154',
        date: '2026-11-19',
      },
    ];
    const waived = build({
      registry: [ac('AC-UI-01', { layers: ['PW'] })],
      waivers,
    });
    expect(statusOf(waived, 'AC-UI-01')).toMatchObject({
      status: 'WAIVED',
      waiver: { approvedBy: '@Eshwar154' },
    });
    const failed = build({
      registry: [ac('AC-UI-01', { layers: ['PW'] })],
      waivers,
      reports: [
        report([
          test(
            'opens (AC-UI-01)',
            'failed',
            'PW',
            'tests/e2e/payments.spec.ts',
          ),
        ]),
      ],
    });
    expect(statusOf(failed, 'AC-UI-01')?.status).toBe('FAILED');
  });
});

describe('scope and summary', () => {
  it('lists only the criteria this repository runs and counts the others', () => {
    const m = build({
      registry: [
        ac('AC-DB-01'),
        ac('AC-UI-01', { repo: 'frontend', layers: ['PW'] }),
        ac('AC-REG-15', { repo: 'both', layers: ['STATIC'] }),
      ],
    });
    expect(m.acs.map((a) => a.acId)).toEqual(['AC-DB-01', 'AC-REG-15']);
    expect(m.summary.outOfScope).toBe(1);
  });

  it('counts every status, so nothing can be hidden in a total', () => {
    const m = build({
      registry: [
        ac('AC-DB-01'),
        ac('AC-API-07', {
          blockedReason: 'secret rule pending',
          initialStatus: 'BLOCKED',
        }),
      ],
    });
    expect(m.summary.byStatus).toMatchObject({
      DONE: 0,
      FAILED: 0,
      BLOCKED: 1,
      'NOT RUN': 1,
      'NOT VERIFIED': 0,
      WAIVED: 0,
    });
    expect(m.summary.total).toBe(2);
  });

  it('records the scan outcome and the run metadata', () => {
    const m = build({ registry: [ac('AC-DB-01')] });
    expect(m.meta).toMatchObject({
      repo: 'store-forge-api',
      commit: 'abc1234def5678',
      node: 'v24.18.0',
      dirty: false,
    });
    expect(m.scan).toEqual(clean);
  });
});

describe('evidence records carry every required field', () => {
  it('one record per artifact with AC, artifact, SHA-256, repo, commit, test, command, timestamp, environment, result, status', () => {
    const m = build({
      registry: [ac('AC-RLS-02')],
      reports: [
        report([test('secret columns denied (AC-RLS-02)', 'passed', 'PG')], {
          command: 'npm run test:e2e -- test/payments-database.e2e-spec.ts',
        }),
      ],
      entries: [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
      files: present({ 'database-evidence/AC-RLS-02.json': 120 }),
    });
    expect(m.records).toEqual([
      {
        acId: 'AC-RLS-02',
        artifact: 'database-evidence/AC-RLS-02.json',
        sha256: 'sha-database-evidence/AC-RLS-02.json',
        repo: 'store-forge-api',
        commit: 'abc1234def5678',
        testName: 'captured AC-RLS-02',
        command: 'npm run test:e2e -- test/payments-database.e2e-spec.ts',
        timestamp: '2026-11-19T09:59:00.000Z',
        environment: 'pglite',
        actualResult: 'observed it',
        status: 'DONE',
      },
    ]);
  });

  it('still records an artifact whose criterion is not DONE, with that status', () => {
    const m = build({
      registry: [ac('AC-RLS-02')],
      reports: [report([test('a (AC-RLS-02)', 'failed', 'PG')])],
      entries: [entry('AC-RLS-02', 'database-evidence/AC-RLS-02.json')],
      files: present({ 'database-evidence/AC-RLS-02.json': 120 }),
    });
    expect(m.records[0]?.status).toBe('FAILED');
  });
});

describe('vitest report parsing and per-AC extracts', () => {
  const json = {
    testResults: [
      {
        name: 'C:/repo/src/a.spec.ts',
        assertionResults: [
          { fullName: 'round trip (AC-ENC-01)', status: 'passed' },
          { fullName: 'tamper (AC-ENC-02)', status: 'failed' },
        ],
      },
      {
        name: 'C:/repo/test/payments-database.e2e-spec.ts',
        assertionResults: [
          { fullName: 'denied (AC-RLS-02)', status: 'passed' },
        ],
      },
    ],
  };

  it('reads every assertion with its repo-relative file and layer', () => {
    const r = parseVitestReport(json, {
      path: 'test-results/u.json',
      sha256: 'h',
      command: 'npm test',
      environment: 'unit',
      repoRoot: 'C:/repo',
    });
    expect(r.results).toEqual([
      {
        file: 'src/a.spec.ts',
        fullName: 'round trip (AC-ENC-01)',
        status: 'passed',
        layer: 'U',
      },
      {
        file: 'src/a.spec.ts',
        fullName: 'tamper (AC-ENC-02)',
        status: 'failed',
        layer: 'U',
      },
      {
        file: 'test/payments-database.e2e-spec.ts',
        fullName: 'denied (AC-RLS-02)',
        status: 'passed',
        layer: 'PG',
      },
    ]);
  });

  it('rejects a document that is not a vitest report', () => {
    expect(() =>
      parseVitestReport(
        { nope: true },
        {
          path: 'x',
          sha256: 'h',
          command: 'c',
          environment: 'unit',
          repoRoot: '/r',
        },
      ),
    ).toThrow(/vitest/i);
  });

  it('renders an extract naming the command, commit and each test, and writes one for every criterion that ran a test', () => {
    const r = parseVitestReport(json, {
      path: 'test-results/u.json',
      sha256: 'h',
      command: 'npm test',
      environment: 'unit',
      repoRoot: 'C:/repo',
    });
    const registry = [
      ac('AC-ENC-01', {
        layers: ['U'],
        evidenceFiles: ['test-results/AC-ENC-01.txt'],
      }),
      ac('AC-ENC-02', {
        layers: ['U'],
        evidenceFiles: ['test-results/AC-ENC-02.txt'],
      }),
      ac('AC-ENC-05', {
        layers: ['U'],
        evidenceFiles: ['test-results/AC-ENC-05.txt'],
      }),
      ac('AC-RLS-02'),
    ];
    const files = extractsToWrite(registry, [r], META);
    expect(files.map((f) => f.file)).toEqual([
      'test-results/AC-ENC-01.txt',
      'test-results/AC-ENC-02.txt',
    ]);
    const text = renderTestExtract('AC-ENC-02', [r], META);
    expect(text).toContain('AC-ENC-02');
    expect(text).toContain('npm test');
    expect(text).toContain('abc1234def5678');
    expect(text).toContain('[U] failed  tamper (AC-ENC-02)');
  });
});
