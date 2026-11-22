import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digestTree,
  loadSentinels,
  scanTree,
  sentinelVariants,
} from './scan.js';

const SECRET = 'SYNTH-secret-Ab12Cd34Ef56Gh78';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-scan-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadSentinels', () => {
  it('reads a JSON array from QA_SENTINELS', () => {
    expect(
      loadSentinels({
        QA_SENTINELS: JSON.stringify([SECRET, 'another-long-sentinel']),
      }),
    ).toEqual([SECRET, 'another-long-sentinel']);
  });

  it('is empty when nothing is configured', () => {
    expect(loadSentinels({})).toEqual([]);
    expect(loadSentinels({ QA_SENTINELS: '' })).toEqual([]);
  });

  it('refuses a malformed value and sentinels too short to be meaningful', () => {
    expect(() => loadSentinels({ QA_SENTINELS: 'not json' })).toThrow(
      /QA_SENTINELS/,
    );
    expect(() => loadSentinels({ QA_SENTINELS: '{"a":1}' })).toThrow(/array/);
    expect(() => loadSentinels({ QA_SENTINELS: '["abc"]' })).toThrow(
      /at least 8/,
    );
    expect(() => loadSentinels({ QA_SENTINELS: '[1]' })).toThrow(/string/);
  });

  it('never echoes a sentinel in an error message', () => {
    try {
      loadSentinels({ QA_SENTINELS: JSON.stringify(['short']) });
    } catch (e) {
      expect((e as Error).message).not.toContain('short');
      return;
    }
    throw new Error('expected a failure');
  });
});

describe('sentinelVariants', () => {
  it('covers the raw value and the encodings a leak commonly takes', () => {
    const v = sentinelVariants('pa ss&word/1=2');
    expect(v).toContain('pa ss&word/1=2');
    expect(v).toContain(Buffer.from('pa ss&word/1=2').toString('base64'));
    expect(v).toContain(encodeURIComponent('pa ss&word/1=2'));
    expect(new Set(v).size).toBe(v.length);
  });
});

describe('scanTree', () => {
  it('reports a clean tree', () => {
    writeFileSync(join(root, 'logs', 'a.txt'), 'nothing to see here');
    const result = scanTree(root, [SECRET]);
    expect(result.findings).toEqual([]);
    expect(result.scannedFiles).toBe(1);
    expect(result.sentinelCount).toBe(1);
  });

  it('finds the raw value, its base64 and its url-encoded form, in text and in binary files', () => {
    writeFileSync(join(root, 'logs', 'raw.txt'), `line ${SECRET} line`);
    writeFileSync(
      join(root, 'logs', 'b64.txt'),
      Buffer.from(SECRET).toString('base64'),
    );
    writeFileSync(
      join(root, 'logs', 'url.txt'),
      `x=${encodeURIComponent(SECRET + ' &')}`,
    );
    writeFileSync(
      join(root, 'shot.png'),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        Buffer.from(SECRET),
        Buffer.from([0, 1, 2]),
      ]),
    );
    const files = scanTree(root, [SECRET])
      .findings.map((f) => f.file)
      .sort();
    expect(files).toEqual([
      'logs/b64.txt',
      'logs/raw.txt',
      'logs/url.txt',
      'shot.png',
    ]);
  });

  it.each([0, 1, 2])(
    'finds the value inside a larger base64 blob at every byte alignment (offset %i)',
    (offset) => {
      const blob = Buffer.concat([
        Buffer.from('x'.repeat(offset)),
        Buffer.from(SECRET),
        Buffer.from('tail-bytes-after'),
      ]).toString('base64');
      writeFileSync(join(root, 'blob.txt'), `token=${blob}`);
      expect(scanTree(root, [SECRET]).findings.map((f) => f.form)).toEqual([
        'base64',
      ]);
    },
  );

  it('scans nested folders and reports forward-slash paths relative to the root', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'deep.json'), `{"x":"${SECRET}"}`);
    expect(scanTree(root, [SECRET]).findings[0]?.file).toBe('a/b/deep.json');
  });

  it('never includes a sentinel value in its result', () => {
    writeFileSync(join(root, 'logs', 'raw.txt'), SECRET);
    const text = JSON.stringify(scanTree(root, [SECRET]));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  it('reports which sentinel by position, and the form it appeared in', () => {
    writeFileSync(
      join(root, 'x.txt'),
      Buffer.from('second-sentinel-value').toString('base64'),
    );
    const [finding] = scanTree(root, [
      SECRET,
      'second-sentinel-value',
    ]).findings;
    expect(finding).toMatchObject({
      file: 'x.txt',
      sentinelIndex: 1,
      form: 'base64',
    });
  });

  it('skips node_modules and a scan-result file it wrote itself is still scanned like any other', () => {
    mkdirSync(join(root, 'node_modules', 'p'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'p', 'i.js'), SECRET);
    expect(scanTree(root, [SECRET]).findings).toEqual([]);
  });

  it('fails when there is nothing to scan for, so a missing sentinel list is never read as clean', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(() => scanTree(root, [])).toThrow(/no sentinels/i);
  });

  it('fails when the folder does not exist', () => {
    expect(() => scanTree(join(root, 'missing'), [SECRET])).toThrow(
      /does not exist/i,
    );
  });
});

describe('JSON-escaped sentinels', () => {
  it('finds a sentinel containing a quote when it was serialized as JSON', () => {
    const tricky = 'abcd"efgh-Sentinel-1234';
    writeFileSync(join(root, 'logs', 'a.json'), JSON.stringify({ v: tricky }));
    const result = scanTree(root, [tricky]);
    expect(result.findings).toEqual([
      { file: 'logs/a.json', sentinelIndex: 0, form: 'json' },
    ]);
  });
});

describe('digestTree', () => {
  it('changes when a scanned file changes and ignores the scan and manifest results', () => {
    writeFileSync(join(root, 'logs', 'a.txt'), 'one');
    const first = scanTree(root, [SECRET]).filesDigest;
    mkdirSync(join(root, 'summary'), { recursive: true });
    writeFileSync(join(root, 'summary', 'secret-scan.json'), '{}');
    writeFileSync(join(root, 'summary', 'manifest.json'), '{}');
    expect(digestTree(root)).toBe(first);
    writeFileSync(join(root, 'logs', 'a.txt'), 'two');
    expect(digestTree(root)).not.toBe(first);
  });
});

describe('root spelling', () => {
  it('reports the same relative paths and digest with or without a trailing separator', () => {
    mkdirSync(join(root, 'summary'), { recursive: true });
    writeFileSync(join(root, 'summary', 'secret-scan.json'), '{}');
    writeFileSync(join(root, 'logs', 'a.txt'), SECRET);
    const plain = scanTree(root, [SECRET]);
    const slashed = scanTree(`${root}/`, [SECRET]);
    expect(slashed.findings).toEqual(plain.findings);
    expect(plain.findings[0]?.file).toBe('logs/a.txt');
    expect(slashed.filesDigest).toBe(plain.filesDigest);
    expect(digestTree(`${root}/`)).toBe(digestTree(root));
  });
});
