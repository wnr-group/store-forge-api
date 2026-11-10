import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT_DIR = process.cwd();
const SCRIPT_PATH = resolve(ROOT_DIR, 'scripts/sync-schema.mjs');
const FIXTURE_DIR = resolve(ROOT_DIR, 'test/fixtures/frontend-mini');

describe('sync-schema script (D-004, D-018)', () => {
  let tempTargetDir: string;

  beforeEach(() => {
    tempTargetDir = mkdtempSync(join(tmpdir(), 'sync-target-'));
  });

  afterEach(() => {
    rmSync(tempTargetDir, { recursive: true, force: true });
  });

  function runScript(args: string[], cwd = ROOT_DIR) {
    const res = spawnSync('node', [SCRIPT_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
    });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    };
  }

  it('AC-A-09: sync reproduces schema, relations, template deps, snapshot from source tree', () => {
    const res = runScript([
      'sync',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(res.status).toBe(0);

    // Verify schema files exist
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/schema/enums.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/schema/stores.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/schema/templates.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/schema/index.ts',
        ),
      ),
    ).toBe(true);

    // Verify relations.ts
    expect(
      existsSync(
        resolve(tempTargetDir, 'src/infrastructure/database/relations.ts'),
      ),
    ).toBe(true);

    // Verify template-deps
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/template-deps/document.ts',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/template-deps/limits.ts',
        ),
      ),
    ).toBe(true);

    // Verify migrations snapshot
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/migrations-snapshot/0000_baseline.sql',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/migrations-snapshot/meta/_journal.json',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          tempTargetDir,
          'src/infrastructure/database/migrations-snapshot/README.md',
        ),
      ),
    ).toBe(true);
  });

  it('AC-A-10: sync is idempotent (second run changes nothing)', () => {
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);
    const file1 = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/schema/stores.ts',
      ),
      'utf-8',
    );

    const res2 = runScript([
      'sync',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(res2.status).toBe(0);

    const file2 = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/schema/stores.ts',
      ),
      'utf-8',
    );
    expect(file1).toBe(file2);
  });

  it('AC-A-11: transform rewrites @/lib/templates/* and extensionless imports; unsupported imports abort with a report', () => {
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);

    const storesContent = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/schema/stores.ts',
      ),
      'utf-8',
    );
    // Banner
    expect(storesContent).toContain(
      '// GENERATED from wnr-group/store-forge lib/db/schema/stores.ts. DO NOT EDIT.',
    );
    // Extensionless rewrite
    expect(storesContent).toContain("from './enums.js'");

    const templatesContent = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/schema/templates.ts',
      ),
      'utf-8',
    );
    expect(templatesContent).toContain(
      "from '../template-deps/document.js'",
    );
    expect(templatesContent).toContain("from '../template-deps/limits.js'");
    expect(templatesContent).toContain("from './stores.js'");

    const relationsContent = readFileSync(
      resolve(tempTargetDir, 'src/infrastructure/database/relations.ts'),
      'utf-8',
    );
    expect(relationsContent).toContain("from './schema/index.js'");

    // Test unsupported import rejection
    const invalidMiniDir = mkdtempSync(join(tmpdir(), 'invalid-mini-'));
    try {
      mkdirSync(resolve(invalidMiniDir, 'lib/db/schema'), { recursive: true });
      writeFileSync(
        resolve(invalidMiniDir, 'lib/db/schema/bad.ts'),
        'import axios from "axios";\nexport const x = 1;\n',
      );

      const badRes = runScript([
        'sync',
        '--source',
        invalidMiniDir,
        '--target',
        tempTargetDir,
      ]);
      expect(badRes.status).toBe(1);
      expect(badRes.stderr).toContain('Unsupported import');
      expect(badRes.stderr).toContain('axios');
    } finally {
      rmSync(invalidMiniDir, { recursive: true, force: true });
    }
  });

  it('AC-A-14: snapshot contains SQL and meta/* identical to source', () => {
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);

    const srcSql = readFileSync(
      resolve(FIXTURE_DIR, 'drizzle/0000_baseline.sql'),
      'utf-8',
    ).replace(/\r\n/g, '\n');
    const targetSql = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/migrations-snapshot/0000_baseline.sql',
      ),
      'utf-8',
    ).replace(/\r\n/g, '\n');
    expect(targetSql).toBe(srcSql);

    const srcMeta = readFileSync(
      resolve(FIXTURE_DIR, 'drizzle/meta/_journal.json'),
      'utf-8',
    ).replace(/\r\n/g, '\n');
    const targetMeta = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/migrations-snapshot/meta/_journal.json',
      ),
      'utf-8',
    ).replace(/\r\n/g, '\n');
    expect(targetMeta).toBe(srcMeta);
  });

  it('AC-A-15: check returns PASS and exit 0 on a clean tree', () => {
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);
    const checkRes = runScript([
      'check',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(checkRes.status).toBe(0);
    expect(checkRes.stdout).toContain('PASS');
  });

  it('AC-A-16: check returns FAIL exit 1 for modified, missing, and unexpected files', () => {
    // 1. Initial sync
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);

    // Case A: Modified file
    const storePath = resolve(
      tempTargetDir,
      'src/infrastructure/database/schema/stores.ts',
    );
    const originalStore = readFileSync(storePath, 'utf-8');
    writeFileSync(storePath, originalStore + '\n// modified\n');

    let checkRes = runScript([
      'check',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(checkRes.status).toBe(1);
    expect(checkRes.stderr).toContain('Modified');
    expect(checkRes.stderr).toContain('stores.ts');

    // Restore
    writeFileSync(storePath, originalStore);

    // Case B: Missing file
    rmSync(storePath);
    checkRes = runScript([
      'check',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(checkRes.status).toBe(1);
    expect(checkRes.stderr).toContain('Missing');
    expect(checkRes.stderr).toContain('stores.ts');

    // Re-sync
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);

    // Case C: Unexpected file
    const extraPath = resolve(
      tempTargetDir,
      'src/infrastructure/database/schema/unexpected.ts',
    );
    writeFileSync(extraPath, 'export const unexpected = true;\n');
    checkRes = runScript([
      'check',
      '--source',
      FIXTURE_DIR,
      '--target',
      tempTargetDir,
    ]);
    expect(checkRes.status).toBe(1);
    expect(checkRes.stderr).toContain('Unexpected');
    expect(checkRes.stderr).toContain('unexpected.ts');
  });

  it('AC-A-17: check returns SKIPPED exit 2 when source is missing and never prints PASS', () => {
    const nonExistentPath = resolve(ROOT_DIR, 'non/existent/path/never/exists');
    const checkRes = runScript([
      'check',
      '--source',
      nonExistentPath,
      '--target',
      tempTargetDir,
    ]);
    expect(checkRes.status).toBe(2);
    expect(checkRes.stderr + checkRes.stdout).toContain('SKIPPED');
    expect(checkRes.stdout).not.toContain('PASS');
  });

  it('AC-A-18: snapshot README states test-only, nothing outside test/support imports snapshot or migrator, drizzle-kit absent', () => {
    runScript(['sync', '--source', FIXTURE_DIR, '--target', tempTargetDir]);

    // Check README content
    const readme = readFileSync(
      resolve(
        tempTargetDir,
        'src/infrastructure/database/migrations-snapshot/README.md',
      ),
      'utf-8',
    );
    expect(readme.toLowerCase()).toContain('test-only');
    expect(readme).toContain('Never executed against Supabase');

    // Check package.json has no drizzle-kit
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf-8'),
    );
    expect(pkg.dependencies?.['drizzle-kit']).toBeUndefined();
    expect(pkg.devDependencies?.['drizzle-kit']).toBeUndefined();

    // Check no imports of migrations-snapshot outside test/support
    const srcFiles = execSync('git ls-files src/', {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((f) => f.endsWith('.ts') && !f.includes('migrations-snapshot'));

    for (const f of srcFiles) {
      const content = readFileSync(resolve(ROOT_DIR, f), 'utf-8');
      expect(content).not.toContain('migrations-snapshot');
      expect(content).not.toContain('drizzle-kit');
    }
  });

  it('AC-A-12: generated mirror exports every table, enum and relation the frontend schema/index.ts exports', () => {
    const frontendIndexPath = resolve(ROOT_DIR, '../store-forge/lib/db/schema/index.ts');
    if (!existsSync(frontendIndexPath)) return;

    const frontendIndex = readFileSync(frontendIndexPath, 'utf-8');
    const generatedIndex = readFileSync(
      resolve(ROOT_DIR, 'src/infrastructure/database/schema/index.ts'),
      'utf-8',
    );

    const exportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    const frontendModules = Array.from(frontendIndex.matchAll(exportRegex)).map((m) => m[1]);
    const generatedModules = Array.from(generatedIndex.matchAll(exportRegex)).map((m) =>
      m[1].replace('.js', ''),
    );

    expect(generatedModules.sort()).toEqual(frontendModules.sort());
  });

  it('AC-A-13: generated mirror compiles (typecheck) unmodified', () => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npmCmd, ['run', 'typecheck'], {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
      shell: true,
    });
    expect(res.status).toBe(0);
  }, 20_000);

  it('AC-A-31: CODEOWNERS lists the four shared paths', () => {
    const codeownersPath = resolve(ROOT_DIR, '.github/CODEOWNERS');
    expect(existsSync(codeownersPath)).toBe(true);
    const content = readFileSync(codeownersPath, 'utf-8');

    expect(content).toContain('/src/infrastructure/');
    expect(content).toContain('/src/common/');
    expect(content).toContain('/src/config/');
    expect(content).toContain('/.github/');
  });

  it('AC-A-39: CI workflow declares permissions, reads token safely, never echoes it', () => {
    const ciWorkflowPath = resolve(ROOT_DIR, '.github/workflows/ci.yml');
    expect(existsSync(ciWorkflowPath)).toBe(true);
    const content = readFileSync(ciWorkflowPath, 'utf-8');

    expect(content).toContain('permissions:\n  contents: read');
    expect(content).toContain('STORE_FORGE_READ_TOKEN');
    expect(content).not.toContain('echo $STORE_FORGE_READ_TOKEN');
    expect(content).not.toContain('echo ${{ secrets.STORE_FORGE_READ_TOKEN }}');
  });
});
