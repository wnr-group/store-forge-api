import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureEvidence,
  ensureEvidenceStructure,
  EVIDENCE_FOLDERS,
  EvidenceLeakError,
} from './writer.js';

const SECRET = 'SYNTH-secret-Ab12Cd34Ef56Gh78';
let root: string;
const env = (extra: Record<string, string> = {}) => ({
  QA_EVIDENCE: '1',
  QA_EVIDENCE_DIR: root,
  QA_SENTINELS: JSON.stringify([SECRET]),
  ...extra,
});
const base = {
  acId: 'AC-RLS-02',
  folder: 'database-evidence' as const,
  layer: 'PG' as const,
  environment: 'pglite' as const,
  actualResult: 'permission denied for all four secret columns',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-writer-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('evidence folder structure', () => {
  it('creates exactly the agreed folders', () => {
    ensureEvidenceStructure(root);
    expect(readdirSync(root).sort()).toEqual([...EVIDENCE_FOLDERS].sort());
    expect([...EVIDENCE_FOLDERS].sort()).toEqual([
      'api-evidence',
      'database-evidence',
      'logs',
      'playwright-report',
      'screenshots',
      'summary',
      'test-results',
    ]);
  });
});

describe('captureEvidence: assertion first, then capture', () => {
  it('runs the assertion before producing anything, and a failing assertion writes nothing', async () => {
    const content = vi.fn(() => ({ denied: true }));
    await expect(
      captureEvidence(
        {
          ...base,
          assert: () => {
            throw new Error('not denied');
          },
          content,
        },
        env(),
      ),
    ).rejects.toThrow('not denied');
    expect(content).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'database-evidence'))).toBe(false);
  });

  it('waits for an asynchronous assertion', async () => {
    const order: string[] = [];
    await captureEvidence(
      {
        ...base,
        assert: async () => {
          await Promise.resolve();
          order.push('assert');
        },
        content: () => {
          order.push('content');
          return { ok: true };
        },
      },
      env(),
    );
    expect(order).toEqual(['assert', 'content']);
  });

  it('is inactive unless QA_EVIDENCE=1: the assertion still runs, nothing is written', async () => {
    const assert = vi.fn();
    const content = vi.fn(() => ({}));
    const result = await captureEvidence(
      { ...base, assert, content },
      { QA_EVIDENCE_DIR: root },
    );
    expect(result).toEqual({ written: false });
    expect(assert).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it('writes the artifact and one provenance entry when active', async () => {
    const result = await captureEvidence(
      {
        ...base,
        assert: () => undefined,
        content: () => ({ column: 'iv', denied: true }),
        testName: 'secret columns denied',
      },
      env(),
    );
    expect(result).toEqual({
      written: true,
      file: 'database-evidence/AC-RLS-02.json',
    });
    expect(
      JSON.parse(
        readFileSync(join(root, 'database-evidence', 'AC-RLS-02.json'), 'utf8'),
      ),
    ).toEqual({
      column: 'iv',
      denied: true,
    });
    const lines = readFileSync(
      join(root, 'summary', 'evidence-entries.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, string>;
    expect(entry).toMatchObject({
      acId: 'AC-RLS-02',
      artifact: 'database-evidence/AC-RLS-02.json',
      testName: 'secret columns denied',
      layer: 'PG',
      environment: 'pglite',
      actualResult: base.actualResult,
    });
    expect(new Date(entry.timestamp ?? '').toISOString()).toBe(entry.timestamp);
  });

  it('keeps one entry per artifact when several are written for the same criterion', async () => {
    await captureEvidence(
      {
        ...base,
        assert: () => undefined,
        content: () => ({ n: 1 }),
        fileName: 'AC-RLS-02-a.json',
      },
      env(),
    );
    await captureEvidence(
      {
        ...base,
        assert: () => undefined,
        content: () => ({ n: 2 }),
        fileName: 'AC-RLS-02-b.json',
      },
      env(),
    );
    const lines = readFileSync(
      join(root, 'summary', 'evidence-entries.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    expect(
      lines.map((l) => (JSON.parse(l) as { artifact: string }).artifact),
    ).toEqual([
      'database-evidence/AC-RLS-02-a.json',
      'database-evidence/AC-RLS-02-b.json',
    ]);
  });

  it('writes text and binary content as given', async () => {
    await captureEvidence(
      {
        ...base,
        folder: 'logs',
        fileName: 'AC-RLS-02.txt',
        assert: () => undefined,
        content: () => 'plain text',
      },
      env(),
    );
    await captureEvidence(
      {
        ...base,
        folder: 'screenshots',
        fileName: 'AC-RLS-02-x.png',
        assert: () => undefined,
        content: () => Buffer.from([1, 2, 3]),
      },
      env(),
    );
    expect(readFileSync(join(root, 'logs', 'AC-RLS-02.txt'), 'utf8')).toBe(
      'plain text',
    );
    expect([
      ...readFileSync(join(root, 'screenshots', 'AC-RLS-02-x.png')),
    ]).toEqual([1, 2, 3]);
  });
});

describe('captureEvidence: leakage protection', () => {
  it('refuses to produce evidence when no sentinels are configured', async () => {
    await expect(
      captureEvidence(
        { ...base, assert: () => undefined, content: () => ({}) },
        env({ QA_SENTINELS: '' }),
      ),
    ).rejects.toThrow(/QA_SENTINELS/);
    expect(existsSync(join(root, 'database-evidence'))).toBe(false);
  });

  it('refuses content that contains a sentinel, writes nothing, and never repeats the value', async () => {
    let message = '';
    try {
      await captureEvidence(
        {
          ...base,
          assert: () => undefined,
          content: () => ({ leaked: `value ${SECRET}` }),
        },
        env(),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceLeakError);
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(SECRET);
    expect(existsSync(join(root, 'database-evidence', 'AC-RLS-02.json'))).toBe(
      false,
    );
    expect(existsSync(join(root, 'summary', 'evidence-entries.jsonl'))).toBe(
      false,
    );
  });

  it('also refuses a sentinel hidden in the recorded result text', async () => {
    await expect(
      captureEvidence(
        {
          ...base,
          actualResult: `denied ${SECRET}`,
          assert: () => undefined,
          content: () => ({}),
        },
        env(),
      ),
    ).rejects.toBeInstanceOf(EvidenceLeakError);
  });
});

describe('captureEvidence: file names', () => {
  it.each([
    ['one that does not start with the criterion id', 'other.json'],
    ['one with a path separator', 'AC-RLS-02/../x.json'],
    ['one with a backslash', 'AC-RLS-02\\x.json'],
    ['one that climbs out of the folder', '../AC-RLS-02.json'],
    ['an empty one', ''],
  ])('refuses %s', async (_label, fileName) => {
    await expect(
      captureEvidence(
        { ...base, fileName, assert: () => undefined, content: () => ({}) },
        env(),
      ),
    ).rejects.toThrow(/file name/i);
  });

  it('refuses an id that is not an acceptance-criterion id', async () => {
    await expect(
      captureEvidence(
        { ...base, acId: 'nope', assert: () => undefined, content: () => ({}) },
        env(),
      ),
    ).rejects.toThrow(/AC id/i);
  });
});
