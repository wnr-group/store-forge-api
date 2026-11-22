import { describe, expect, it } from 'vitest';
import {
  compareProjectRefs,
  databaseProjectRef,
  supabaseProjectRef,
} from './project-ref.js';

describe('project-ref extraction and comparison (AC-B-88)', () => {
  it('AC-B-88: databaseProjectRef extracts project ref from storeforge_app.<ref>', () => {
    expect(
      databaseProjectRef(
        'postgresql://storeforge_app.abc123:pw@aws-0.pooler.supabase.com:6543/postgres',
      ),
    ).toBe('abc123');
    expect(
      databaseProjectRef(
        'postgresql://storeforge_app:pw@localhost:5432/postgres',
      ),
    ).toBeUndefined();
    expect(databaseProjectRef('not-a-valid-url')).toBeUndefined();
  });

  it('AC-B-88: supabaseProjectRef extracts project ref from <ref>.supabase.co', () => {
    expect(supabaseProjectRef('https://abc123.supabase.co')).toBe('abc123');
    expect(supabaseProjectRef('https://ABC123.supabase.co')).toBe('abc123');
    expect(supabaseProjectRef('http://localhost:54321')).toBeUndefined();
    expect(supabaseProjectRef('https://api.example.com')).toBeUndefined();
    expect(supabaseProjectRef('invalid-url')).toBeUndefined();
  });

  it('AC-B-88: compareProjectRefs matches, mismatches and skips correctly', () => {
    expect(compareProjectRefs('abc123', 'abc123')).toBe('match');
    expect(compareProjectRefs('ABC123', 'abc123')).toBe('match');
    expect(compareProjectRefs('abc123', 'xyz999')).toBe('mismatch');
    expect(compareProjectRefs('abc123', undefined)).toBe('skipped');
    expect(compareProjectRefs(undefined, 'abc123')).toBe('skipped');
    expect(compareProjectRefs(undefined, undefined)).toBe('skipped');
  });
});
