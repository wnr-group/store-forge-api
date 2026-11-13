import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = process.cwd();

describe('Single database implementation (D-004)', () => {
  it('AC-A-18: src/database is the only database layer, with its migrations and drizzle-kit', () => {
    expect(existsSync(resolve(ROOT_DIR, 'src/infrastructure'))).toBe(false);
    expect(
      existsSync(resolve(ROOT_DIR, 'src/database/database.module.ts')),
    ).toBe(true);
    expect(
      existsSync(
        resolve(ROOT_DIR, 'src/database/migrations/meta/_journal.json'),
      ),
    ).toBe(true);

    const pkg = JSON.parse(
      readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf-8'),
    );
    expect(pkg.devDependencies?.['drizzle-kit']).toBeDefined();

    const files = execSync('git ls-files src/ test/ scripts/', {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          f !== 'test/database-layer.spec.ts' &&
          existsSync(resolve(ROOT_DIR, f)),
      );
    for (const f of files) {
      const content = readFileSync(resolve(ROOT_DIR, f), 'utf-8');
      expect(content, f).not.toContain('infrastructure/database');
      expect(content, f).not.toContain('migrations-snapshot');
    }
  });
});
