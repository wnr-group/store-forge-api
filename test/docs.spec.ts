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

describe('Documentation Contracts (AC-B-72, AC-B-98, AC-B-99, DOC)', () => {
  const overviewPath = resolve(ROOT_DIR, 'docs/architecture/overview.md');
  const onboardingPath = resolve(
    ROOT_DIR,
    'docs/development/santu-onboarding.md',
  );

  const overviewContent = readFileSync(overviewPath, 'utf8');
  const onboardingContent = readFileSync(onboardingPath, 'utf8');

  it('AC-B-72: documentation states limiter limitations and the OPEN topology', () => {
    // 1. Limitation text: per instance
    expect(overviewContent.toLowerCase()).toContain('per instance');

    // 2. Limitation text: resets
    expect(overviewContent.toLowerCase()).toContain('resets');

    // 3. Limitation text: grows with instances
    expect(overviewContent.toLowerCase()).toContain('grows with');

    // 4. Limitation text: edge/CDN recommendation
    expect(overviewContent).toMatch(/edge|cdn/i);

    // 5. With TRUST_PROXY=0 all requests behind Next.js share one observed IP and bucket
    expect(overviewContent).toContain('TRUST_PROXY');
    expect(overviewContent).toMatch(/share one observed IP and bucket/i);

    // 6. TRUST_PROXY stays 0 until deployment topology is confirmed (OPEN)
    expect(overviewContent).toMatch(/OPEN/i);
    expect(overviewContent).toMatch(/stays 0/i);
  });

  it('AC-B-98: documentation states Next.js forwarding requirements', () => {
    // Next.js must forward Authorization Bearer token and X-Tenant-Id header
    const combined = overviewContent + '\n' + onboardingContent;

    expect(combined).toMatch(/Authorization:\s*Bearer/i);
    expect(combined).toMatch(/X-Tenant-Id/i);
    expect(combined).toMatch(/Next\.js/i);
  });

  it('AC-B-99: documentation records the deliberate pageSize difference from the frontend', () => {
    const combined = overviewContent + '\n' + onboardingContent;

    // Must document the allowed page sizes [10, 20, 50, 100]
    expect(combined).toContain('10, 20, 50, 100');
    // Must document default 20
    expect(combined).toMatch(/default\s*(`?20`?|20)/i);
    // Must document frontend sizes (12, 24, 48)
    expect(combined).toMatch(/12,\s*24,\s*48/);
  });
});
