import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFilePaths } from './env-files.js';

describe('envFilePaths and environment precedence (D-016)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'env-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves .env.local before .env', () => {
    const paths = envFilePaths(tempDir);
    expect(paths).toEqual([
      resolve(tempDir, '.env.local'),
      resolve(tempDir, '.env'),
    ]);
  });

  it('AC-A-01: .env.local values override .env', async () => {
    writeFileSync(
      join(tempDir, '.env'),
      'TEST_VAR=from-env\nSHARED_VAR=from-env\n',
    );
    writeFileSync(join(tempDir, '.env.local'), 'TEST_VAR=from-env-local\n');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFilePaths(tempDir),
          ignoreEnvVars: true, // test file precedence specifically
        }),
      ],
    }).compile();

    const configService = moduleRef.get(ConfigService);
    expect(configService.get('TEST_VAR')).toBe('from-env-local');
    await moduleRef.close();
  });

  it('AC-A-02: .env supplies keys absent from .env.local', async () => {
    writeFileSync(join(tempDir, '.env'), 'BASE_ONLY=base-value\nSHARED=base\n');
    writeFileSync(
      join(tempDir, '.env.local'),
      'LOCAL_ONLY=local-value\nSHARED=local\n',
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFilePaths(tempDir),
          ignoreEnvVars: true,
        }),
      ],
    }).compile();

    const configService = moduleRef.get(ConfigService);
    expect(configService.get('LOCAL_ONLY')).toBe('local-value');
    expect(configService.get('SHARED')).toBe('local');
    expect(configService.get('BASE_ONLY')).toBe('base-value');
    await moduleRef.close();
  });

  it('AC-A-03: real process.env wins over both files (documented behaviour)', async () => {
    const originalValue = process.env.PROCESS_OVERRIDE_CANARY;
    process.env.PROCESS_OVERRIDE_CANARY = 'from-real-process-env';

    try {
      writeFileSync(
        join(tempDir, '.env'),
        'PROCESS_OVERRIDE_CANARY=from-env\n',
      );
      writeFileSync(
        join(tempDir, '.env.local'),
        'PROCESS_OVERRIDE_CANARY=from-env-local\n',
      );

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envFilePaths(tempDir),
          }),
        ],
      }).compile();

      const configService = moduleRef.get(ConfigService);
      expect(configService.get('PROCESS_OVERRIDE_CANARY')).toBe(
        'from-real-process-env',
      );
      await moduleRef.close();
    } finally {
      if (originalValue !== undefined) {
        process.env.PROCESS_OVERRIDE_CANARY = originalValue;
      } else {
        delete process.env.PROCESS_OVERRIDE_CANARY;
      }
    }
  });

  it('allows startup when neither .env.local nor .env is present', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFilePaths(tempDir),
          ignoreEnvVars: true,
        }),
      ],
    }).compile();

    const configService = moduleRef.get(ConfigService);
    expect(configService.get('ANYTHING')).toBeUndefined();
    await moduleRef.close();
  });

  it('AC-A-04: .env.local and .env stay git-ignored', () => {
    const rootDir = process.cwd();
    const envIgnored = execSync('git check-ignore -v .env', {
      cwd: rootDir,
    }).toString();
    const envLocalIgnored = execSync('git check-ignore -v .env.local', {
      cwd: rootDir,
    }).toString();

    expect(envIgnored).toContain('.env');
    expect(envLocalIgnored).toContain('.env');
  });

  it('AC-A-05: .env.example and README name .env.local', () => {
    const rootDir = process.cwd();
    const envExample = readFileSync(resolve(rootDir, '.env.example'), 'utf-8');
    const readme = readFileSync(resolve(rootDir, 'README.md'), 'utf-8');

    expect(envExample).toContain('.env.local');
    expect(readme).toContain('.env.local');
  });
});
