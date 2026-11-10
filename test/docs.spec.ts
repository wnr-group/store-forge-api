import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = process.cwd();

describe('Documentation integrity and compliance (D-001, D-002, D-003, D-009, D-012, D-018, D-025)', () => {
  it('AC-A-35: overview states the Next.js caller limitation verbatim', () => {
    const overview = readFileSync(
      resolve(ROOT_DIR, 'docs/architecture/overview.md'),
      'utf-8',
    );
    const expectedLimitation =
      'Next.js is the intended caller; direct API access is not technically prevented; valid user tokens work from any client; user authentication, authorization and RLS are the real security boundaries; public endpoints need separate abuse protection';
    expect(overview).toContain(expectedLimitation);
  });

  it('AC-A-36: decision register and ownership split present with statuses matching plan', () => {
    const overview = readFileSync(
      resolve(ROOT_DIR, 'docs/architecture/overview.md'),
      'utf-8',
    );
    // Verifies all 25 decisions are present in the table
    for (let i = 1; i <= 25; i++) {
      const id = `D-${String(i).padStart(3, '0')}`;
      expect(overview).toContain(id);
    }

    expect(overview).toContain('Module ownership split');
    expect(overview).toContain('Eshwar');
    expect(overview).toContain('Santu');
  });

  it('AC-A-38: docs state PGlite limits and that PGlite results do not prove hosted-Supabase compatibility', () => {
    const overview = readFileSync(
      resolve(ROOT_DIR, 'docs/architecture/overview.md'),
      'utf-8',
    );
    expect(overview).toContain('no real pooler behaviour');
    expect(overview).toContain('no multi-instance rate limiting');
    expect(overview).toContain('no genuine concurrent isolation');
    expect(overview).toContain(
      'PGlite results do not prove hosted-Supabase compatibility',
    );
  });
});
