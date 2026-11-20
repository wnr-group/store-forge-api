import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { captureEvidence } from './support/qa-evidence/writer.js';
import { LogRecorder, SECRET } from './support/payments-secrets.js';

/**
 * Static and middleware checks for the payments feature. A static scan proves the ABSENCE of something in the source (it says
 * nothing about runtime behaviour); each one writes a log under logs/ listing exactly what was scanned and found.
 */

const ROOT = process.cwd();
const norm = (p: string) => relative(ROOT, p).split(sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const source = () =>
  walk(join(ROOT, 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  );
const read = (f: string) => readFileSync(f, 'utf8');

/** The static evidence is a plain-text log of what was scanned and what was found. */
const evidence = (
  acId: string,
  actualResult: string,
  lines: string[],
  assert: () => void,
) =>
  captureEvidence({
    acId,
    folder: 'logs',
    layer: 'STATIC',
    environment: 'unit',
    actualResult,
    assert,
    content: () => `${[`${acId}: ${actualResult}`, ...lines].join('\n')}\n`,
  });

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });

const baseBranch = () => {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/main'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return 'origin/main';
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--verify', 'main'], {
        cwd: ROOT,
        stdio: 'ignore',
      });
      return 'main';
    } catch {
      return 'HEAD';
    }
  }
};

describe('payments static scans', () => {
  it('AC-ENC-09 [layer:STATIC]: no production code can decrypt a stored secret', async () => {
    const files = source();
    const hits = files
      .filter((f) => /decryptSecret|__testing/.test(read(f)))
      .map(norm);
    const barrels = files
      .filter(
        (f) =>
          /(^|\/)index\.ts$/.test(norm(f)) &&
          f.includes(`${sep}payments${sep}`),
      )
      .map(norm);
    await evidence(
      'AC-ENC-09',
      `scanned ${files.length} non-test source files; the decrypt helper is referenced only by ${hits.join(', ')}`,
      [
        `files scanned: ${files.length}`,
        `references: ${hits.join(', ')}`,
        `payments barrels: ${barrels.length}`,
      ],
      () => {
        expect(hits).toEqual(['src/modules/payments/credentials-crypto.ts']);
        expect(barrels).toEqual([]);
      },
    );
  });

  it('AC-RLS-05 [layer:STATIC]: no SQL returns or selects a secret column of the payments table', async () => {
    const files = source().filter(
      (f) => !f.includes(`${sep}database${sep}migrations${sep}`),
    );
    const sqlFiles = files.filter((f) =>
      /tenant_razorpay_config/.test(read(f)),
    );
    const secret = /secret_ciphertext|\biv\b|auth_tag|key_version/;
    const offences: string[] = [];
    for (const f of sqlFiles) {
      for (const stmt of read(f).match(/sql`[\s\S]*?`/g) ?? []) {
        const ret = /returning\s+([^`]*)/i.exec(stmt)?.[1] ?? '';
        if (secret.test(ret) || /returning\s+\*/i.test(stmt))
          offences.push(`${norm(f)}: returning ${ret.trim()}`);
        const sel =
          /select\s+([\s\S]*?)\s+from\s+public\.tenant_razorpay_config/i.exec(
            stmt,
          )?.[1] ?? '';
        if (secret.test(sel) || sel.trim() === '*')
          offences.push(`${norm(f)}: select ${sel.trim()}`);
      }
    }
    await evidence(
      'AC-RLS-05',
      `scanned the SQL in ${sqlFiles.length} source file(s) that touch the payments table: no RETURNING or SELECT of a secret column`,
      [
        `files: ${sqlFiles.map(norm).join(', ')}`,
        `offences: ${offences.length}`,
      ],
      () => {
        expect(sqlFiles.map(norm)).toContain(
          'src/modules/payments/payments.service.ts',
        );
        expect(offences).toEqual([]);
      },
    );
  });

  it('AC-DB-09 [layer:STATIC]: the flag adds no backfill, grant, DTO, accessor or endpoint', async () => {
    const ddl = read(
      join(ROOT, 'src/database/migrations/0035_tenant_customer_auth_flag.sql'),
    )
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const readers = source()
      .filter((f) => /customerAuthEnabled|customer_auth_enabled/.test(read(f)))
      .map(norm);
    await evidence(
      'AC-DB-09',
      '0035 contains one ALTER TABLE ADD COLUMN and nothing else; the flag is referenced only by the schema model',
      [`ddl: ${ddl.trim()}`, `source references: ${readers.join(', ')}`],
      () => {
        expect(ddl.trim()).toMatch(
          /^ALTER TABLE "tenants" ADD COLUMN "customer_auth_enabled" boolean DEFAULT false NOT NULL;$/,
        );
        expect(ddl).not.toMatch(
          /\b(GRANT|REVOKE|UPDATE|INSERT|CREATE POLICY|CREATE FUNCTION)\b/i,
        );
        expect(readers).toEqual(['src/database/schema/tenants.ts']);
      },
    );
  });

  it('AC-DB-12 [layer:STATIC]: migration 0035 does not reference the payments table', async () => {
    const file = read(
      join(ROOT, 'src/database/migrations/0035_tenant_customer_auth_flag.sql'),
    );
    const refs = file.match(/tenant_razorpay_config/gi) ?? [];
    await evidence(
      'AC-DB-12',
      '0035 contains no reference to tenant_razorpay_config',
      [`references: ${refs.length}`],
      () => expect(refs).toHaveLength(0),
    );
  });

  it('AC-SEC-05 [layer:STATIC]: the HTTP request logger formats only method, URL, status and time', async () => {
    const setup = read(join(ROOT, 'src/app.setup.ts'));
    const block = /httpLogger\.log\(\s*`([^`]*)`/.exec(setup)?.[1] ?? '';
    await evidence(
      'AC-SEC-05',
      `the request log line template is: ${block}`,
      [`template: ${block}`],
      () => {
        expect(block).toBe(
          '${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms',
        );
        expect(block).not.toMatch(/body|headers|query|authorization|cookie/i);
      },
    );
  });

  it('AC-REG-15 [layer:STATIC]: no Firebase dependency or integration was introduced', async () => {
    const word = new RegExp(['fire', 'base'].join(''), 'i');
    // test/support/qa-evidence/ holds the acceptance-criterion registry, whose REG-15 row quotes the word it asks us to scan for.
    const diff = git(
      'diff',
      baseBranch(),
      '--unified=0',
      '--',
      'src',
      'test',
      'scripts',
      'package.json',
      'package-lock.json',
      ':(exclude)test/support/qa-evidence',
      // ...and this spec names the criterion in its own title, which would otherwise match once it is committed.
      ':(exclude)test/payments-static.spec.ts',
    );
    const added = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++') && word.test(l));
    const files = git('diff', '--name-only', baseBranch())
      .split('\n')
      .filter(Boolean);
    await evidence(
      'AC-REG-15',
      `scanned the diff against ${baseBranch()} (${files.length} files, including package.json and the lockfile) for the added word, excluding the QA registry folder and this spec: ${added.length} found`,
      [
        `files in diff: ${files.length}`,
        `added lines matching: ${added.length}`,
      ],
      () => expect(added).toEqual([]),
    );
  });

  it('AC-FE-14 [layer:STATIC]: no frontend REST route handler and no Settings change appears in this repository (API half)', async () => {
    // The registry attributes this row to the API repository's static scan; the frontend repository runs its own (and passes).
    const files = git('diff', '--name-only', baseBranch())
      .split('\n')
      .filter(Boolean);
    const handlers = files.filter((f) => /(^|\/)route\.(ts|tsx|js)$/.test(f));
    const settings = files.filter((f) =>
      /(^|\/)(app|components)\/.*settings/i.test(f),
    );
    await evidence(
      'AC-FE-14',
      `${files.length} changed files in the API repository: none is a route handler (route.ts) and none is a Settings page or component`,
      [
        `changed files: ${files.length}`,
        `route handlers added: ${handlers.length}`,
        `Settings page or component files changed: ${settings.length}`,
      ],
      () => {
        expect(handlers).toEqual([]);
        expect(settings).toEqual([]);
      },
    );
  });

  it('AC-SCOPE-01 [layer:STATIC]: no shopper login, registration or authentication enforcement was introduced (API)', async () => {
    const files = git('diff', '--name-only', baseBranch())
      .split('\n')
      .filter(Boolean);
    const authTouched = files.filter((f) =>
      /^src\/modules\/(auth|customers|public)\//.test(f),
    );
    const readers = source()
      .filter((f) => /customerAuthEnabled|customer_auth_enabled/.test(read(f)))
      .map(norm);
    await evidence(
      'AC-SCOPE-01',
      `no file under auth, customers or public modules changed; the flag has no reader beyond its schema model`,
      [
        `changed files: ${files.length}`,
        `auth/customers/public files changed: ${authTouched.length}`,
        `flag readers: ${readers.join(', ')}`,
      ],
      () => {
        expect(authTouched).toEqual([]);
        expect(readers).toEqual(['src/database/schema/tenants.ts']);
      },
    );
  });

  it('AC-SCOPE-02 [layer:STATIC]: no Razorpay SDK, outbound Razorpay call, webhook or payment-processing route (API)', async () => {
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }).filter((d) => /razorpay/i.test(d));
    const src = source().filter(
      (f) => !f.includes(`${sep}database${sep}migrations${sep}`),
    );
    const hosts = src.filter((f) => /razorpay\.com/i.test(read(f))).map(norm);
    const payments = src.filter((f) =>
      f.includes(`${sep}modules${sep}payments${sep}`),
    );
    const outbound = payments
      .filter((f) =>
        /\bfetch\(|axios|https?\.request|from 'node:https?'/.test(read(f)),
      )
      .map(norm);
    const controllers = src
      .filter(
        (f) =>
          f.endsWith('controller.ts') &&
          /payment|webhook|checkout|refund/i.test(
            read(f).match(/@Controller\([^)]*\)/)?.[0] ?? '',
          ),
      )
      .map(norm);
    await evidence(
      'AC-SCOPE-02',
      'no razorpay dependency, razorpay host, outbound HTTP in the payments module, or payment/webhook/checkout/refund controller other than payments/razorpay',
      [
        `razorpay dependencies: ${deps.length}`,
        `razorpay hosts: ${hosts.length}`,
        `outbound calls: ${outbound.length}`,
        `controllers: ${controllers.join(', ')}`,
      ],
      () => {
        expect(deps).toEqual([]);
        expect(hosts).toEqual([]);
        expect(outbound).toEqual([]);
        expect(controllers).toEqual([
          'src/modules/payments/payments.controller.ts',
        ]);
      },
    );
  });
});

describe('HTTP request logger middleware', () => {
  it('AC-SEC-05: logs one line per request with method, URL, status and time, and never the body or headers', () => {
    const handlers: ((
      req: unknown,
      res: EventEmitter,
      next: () => void,
    ) => void)[] = [];
    const settings = {
      apiPrefix: 'api/v1',
      swaggerEnabled: false,
      env: 'development',
      corsOrigins: [] as string[],
    };
    const fakeApp = {
      get: () => ({ get: (key: keyof typeof settings) => settings[key] }),
      getHttpAdapter: () => ({ getInstance: () => ({ set: () => undefined }) }),
      setGlobalPrefix: () => undefined,
      use: (fn: (typeof handlers)[number]) => handlers.push(fn),
      enableCors: () => undefined,
      useGlobalPipes: () => undefined,
      useGlobalFilters: () => undefined,
    };
    const recorder = new LogRecorder();
    Logger.overrideLogger(recorder);
    try {
      configureApp(fakeApp as never);
      // The first handler is the security-header middleware; the request logger is the one that waits for the response.
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      const req = {
        method: 'PUT',
        originalUrl: '/api/v1/payments/razorpay',
        path: '/api/v1/payments/razorpay',
        headers: {
          authorization: 'Bearer token-value',
          'x-organization-id': 'org',
        },
        body: { keyId: 'rzp_test_abcdefgh', keySecret: SECRET },
      };
      for (const handler of handlers.slice(1))
        handler(req, res, () => undefined);
      res.emit('finish');
    } finally {
      Logger.overrideLogger(['error', 'warn']);
    }
    const lines = recorder.entries.map((e) => String(e.message));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^PUT \/api\/v1\/payments\/razorpay 200 \d+ms$/);
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).not.toMatch(/token-value|keySecret|rzp_/);
  });
});
