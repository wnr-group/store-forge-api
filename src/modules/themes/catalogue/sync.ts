import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { themes } from '../../../database/schema/templates.js';
import { THEME_CATALOGUE } from './themes.js';

/**
 * Writes the code-defined catalogue into the `themes` table (insert or update by slug).
 *
 * Run it with the privileged owner connection: the API's own role cannot write to `themes`. To change a theme, edit
 * its definition, raise its `version`, and run `npm run db:seed:themes`. Stores that already applied the theme keep
 * their own copy of the documents; only stores that apply it afterwards get the new version.
 */
export async function syncThemeCatalogue(
  db: PostgresJsDatabase<Record<string, unknown>>,
): Promise<{ slug: string; version: number }[]> {
  const written: { slug: string; version: number }[] = [];
  for (const theme of THEME_CATALOGUE) {
    await db
      .insert(themes)
      .values({
        slug: theme.slug,
        name: theme.name,
        description: theme.description,
        industry: theme.industry,
        version: theme.version,
        previewImage: theme.previewImage,
        status: 'published',
        documents: theme.documents as never,
      })
      .onConflictDoUpdate({
        target: themes.slug,
        set: {
          name: theme.name,
          description: theme.description,
          industry: theme.industry,
          version: theme.version,
          previewImage: theme.previewImage,
          status: 'published',
          documents: theme.documents as never,
          updatedAt: sql`now()`,
        },
      });
    written.push({ slug: theme.slug, version: theme.version });
  }
  return written;
}
