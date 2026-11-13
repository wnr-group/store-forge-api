import { resolve } from 'node:path';

/**
 * Returns the environment file paths in order of precedence:
 * .env.local first (overrides defaults), followed by .env.
 */
export function envFilePaths(cwd: string = process.cwd()): string[] {
  return [resolve(cwd, '.env.local'), resolve(cwd, '.env')];
}
