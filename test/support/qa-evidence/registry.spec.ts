import { existsSync, readFileSync } from 'node:fs';
import { parsePlanMatrix } from './registry.js';

const PLAN = `
### 7.1 Database and migrations
| AC ID | Requirement | Location | Method / test | Pre | Expected | Evidence file | Result | Status |
|---|---|---|---|---|---|---|---|---|
| AC-DB-01 | Migration 0034 applies to an empty database | \`0034\` SQL, journal | PG A \`payments-database mig-0034-apply\` | P2 | No error; table exists | \`database-evidence/AC-DB-01.json\` | - | NOT RUN |
| AC-DB-06 | DB regex and DTO regex agree on one corpus | \`0034\`, DTO | U+PG A \`regex-drift\` | P1,P2 | Identical accept/reject sets | \`test-results/AC-DB-06.txt\` | - | NOT RUN |

### 7.2 RLS and column privileges
| AC ID | Requirement | Location | Method / test | Pre | Expected | Evidence file | Result | Status |
|---|---|---|---|---|---|---|---|---|
| AC-RLS-11b | Real PostgREST direct access denied for an Owner JWT | policies, real project | REAL A HTTP to \`/rest/v1/tenant_razorpay_config\` (select, insert, update, delete) | P8 | All denied | \`api-evidence/AC-RLS-11b.json\` | - | NOT RUN - environment unavailable |

### 7.4 API endpoints
| AC ID | Requirement | Location | Method / test | Pre | Expected | Evidence file | Result | Status |
|---|---|---|---|---|---|---|---|---|
| AC-API-07 | Final secret rule enforced | DTO | HTTP A \`put-secret-rule\` | P3 | Boundary honoured | \`api-evidence/AC-API-07.json\` | - | BLOCKED (secret rule pending) |

### 7.8 Frontend unit and contract
| AC ID | Requirement | Location | Method / test | Pre | Expected | Evidence file | Result | Status |
|---|---|---|---|---|---|---|---|---|
| AC-FE-14 | Settings page unmodified | diff | STATIC A | P6 | No change | \`logs/AC-FE-14.txt\` | - | NOT RUN |
| AC-FE-16 | Reuses the existing design system | payments page | (a) STATIC A diff scan plus FE A render test. (b) PW A at 390px and 1280px widths | (a) P5,P6; (b) P7 | (a) none; (b) layout intact | (a) \`logs/AC-FE-16.txt\`; (b) \`screenshots/AC-FE-16-mobile.png\`, \`screenshots/AC-FE-16-desktop.png\` | - | (a) NOT RUN (feature not implemented); (b) Local: NOT RUN; Hosted: NOT RUN (D22 unknown) |

### 7.10 Regression (AC-REG-01 to AC-REG-15, each independent)
| AC ID | Requirement | Location | Method / test | Evidence file | Result | Status |
|---|---|---|---|---|---|---|
| AC-REG-04 | Team and member management unchanged (incl. 10-then-429) | API team | HTTP A \`test/store-team.e2e-spec.ts\` | \`test-results/AC-REG-04.txt\` | - | NOT RUN |
| AC-REG-15 | No Firebase dependency or integration introduced | both repos | STATIC A scan of diffs, manifests and lockfiles for \`firebase\` | \`logs/AC-REG-15.txt\` | - | NOT RUN |
`;

describe('parsePlanMatrix', () => {
  const entries = parsePlanMatrix(PLAN);
  const byId = (id: string) => {
    const e = entries.find((x) => x.acId === id);
    if (!e) throw new Error(`missing ${id}`);
    return e;
  };

  it('reads every AC row and nothing else', () => {
    expect(entries.map((e) => e.acId)).toEqual([
      'AC-DB-01',
      'AC-DB-06',
      'AC-RLS-11b',
      'AC-API-07',
      'AC-FE-14',
      'AC-FE-16',
      'AC-REG-04',
      'AC-REG-15',
    ]);
  });

  it('reads the nine-column rows', () => {
    const e = byId('AC-DB-01');
    expect(e).toMatchObject({
      section: '7.1',
      requirement: 'Migration 0034 applies to an empty database',
      layers: ['PG'],
      preconditions: 'P2',
      expected: 'No error; table exists',
      evidenceFiles: ['database-evidence/AC-DB-01.json'],
      repo: 'api',
      needsEnvironment: false,
      blockedReason: undefined,
    });
  });

  it('reads the seven-column regression rows, which have no precondition or expected column', () => {
    const e = byId('AC-REG-04');
    expect(e).toMatchObject({
      section: '7.10',
      layers: ['HTTP'],
      evidenceFiles: ['test-results/AC-REG-04.txt'],
      preconditions: '',
      regressionSpecs: ['test/store-team.e2e-spec.ts'],
      expected: '',
      repo: 'api',
    });
  });

  it('requires every layer the row names', () => {
    expect(byId('AC-DB-06').layers).toEqual(['U', 'PG']);
    expect(byId('AC-FE-16').layers).toEqual(['FE', 'PW', 'STATIC']);
  });

  it('flags rows that need a real database or a browser as needing an environment', () => {
    expect(byId('AC-RLS-11b').needsEnvironment).toBe(true);
    expect(byId('AC-FE-16').needsEnvironment).toBe(true);
    expect(byId('AC-DB-01').needsEnvironment).toBe(false);
  });

  it('keeps a blocked row blocked and records why', () => {
    expect(byId('AC-API-07').blockedReason).toBe('secret rule pending');
  });

  it('collects every evidence file in a cell, across (a) and (b) parts', () => {
    expect(byId('AC-FE-16').evidenceFiles).toEqual([
      'logs/AC-FE-16.txt',
      'screenshots/AC-FE-16-mobile.png',
      'screenshots/AC-FE-16-desktop.png',
    ]);
  });

  it('assigns each row to the repository that runs it', () => {
    expect(byId('AC-FE-16').repo).toBe('frontend');
    expect(byId('AC-REG-15').repo).toBe('both');
    expect(byId('AC-RLS-11b').repo).toBe('api');
  });

  it('keeps a static-only frontend row in the frontend scope', () => {
    expect(byId('AC-FE-14').layers).toEqual(['STATIC']);
    expect(byId('AC-FE-14').repo).toBe('frontend');
    expect(byId('AC-REG-15').repo).toBe('both');
  });

  it('never starts a row as anything but NOT RUN or BLOCKED', () => {
    for (const e of entries)
      expect(['NOT RUN', 'BLOCKED']).toContain(e.initialStatus);
  });
});

/** When the frozen plan is available on this machine, check every row of the real matrix parses completely. */
const planPath = process.env.QA_PLAN_FILE;
describe.skipIf(!planPath || !existsSync(planPath))(
  'the real plan matrix',
  () => {
    let entries: ReturnType<typeof parsePlanMatrix> = [];
    beforeAll(() => {
      entries = parsePlanMatrix(readFileSync(planPath ?? '', 'utf8'));
    });

    it('yields unique AC ids', () => {
      const ids = entries.map((e) => e.acId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(150);
    });

    it('gives every row a requirement, a method and at least one layer', () => {
      for (const e of entries) {
        expect(e.requirement, e.acId).not.toBe('');
        expect(e.layers.length, e.acId).toBeGreaterThan(0);
      }
    });

    it('gives every row at least one evidence file', () => {
      expect(
        entries.filter((e) => !e.evidenceFiles.length).map((e) => e.acId),
      ).toEqual([]);
    });
  },
);
