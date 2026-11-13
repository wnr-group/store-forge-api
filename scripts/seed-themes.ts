/**
 * Writes the theme catalogue (src/modules/themes/catalogue) into the `themes` table: `npm run db:seed:themes`.
 *
 * Safe to run any time: themes are inserted or updated by slug. Needs DIRECT_URL (the privileged owner connection:
 * the API's own role has no write access to `themes`). Stores that already applied a theme keep their own copy of its
 * documents; a changed theme only reaches stores that apply it afterwards.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { syncThemeCatalogue } from '../src/modules/themes/catalogue/sync.js';

const url = process.env.DIRECT_URL;
if (!url) {
  console.error('DIRECT_URL is required.');
  process.exit(2);
}
const client = postgres(url, { prepare: false, max: 1, ssl: 'require' });
try {
  const written = await syncThemeCatalogue(drizzle(client));
  for (const t of written) console.log(`${t.slug} v${t.version}`);
  console.log(`${written.length} themes written.`);
} finally {
  await client.end();
}
