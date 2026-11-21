export type RefComparison = 'match' | 'mismatch' | 'skipped';

export function databaseProjectRef(databaseUrl: string): string | undefined {
  try {
    return /^storeforge_app\.(.+)$/.exec(
      decodeURIComponent(new URL(databaseUrl).username),
    )?.[1];
  } catch {
    return undefined;
  }
}

export function supabaseProjectRef(supabaseUrl: string): string | undefined {
  try {
    return /^([a-z0-9]+)\.supabase\.co$/i
      .exec(new URL(supabaseUrl).hostname)?.[1]
      ?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function compareProjectRefs(
  db?: string,
  supabase?: string,
): RefComparison {
  if (!db || !supabase) return 'skipped';
  return db.toLowerCase() === supabase.toLowerCase() ? 'match' : 'mismatch';
}
