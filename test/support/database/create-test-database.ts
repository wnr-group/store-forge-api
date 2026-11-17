import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { FULL_AUTH_STUB, SUPABASE_STUB } from './supabase-stub.js';

export interface TestDatabase {
  url: string;
  pg: PGlite;
  server: PGLiteSocketServer;
  close: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
    srv.on('error', reject);
  });
}

export async function createTestDatabase(
  opts: { fullAuth?: boolean; migrationsFolder?: string } = {},
): Promise<TestDatabase> {
  const pg = new PGlite({ extensions: { pgcrypto } });

  // 1. Apply Supabase stub
  await pg.exec(SUPABASE_STUB);
  if (opts.fullAuth) {
    await pg.exec(FULL_AUTH_STUB);
  }

  // 2. Apply snapshot migrations
  const migrationsFolder =
    opts.migrationsFolder ?? resolve(process.cwd(), 'src/database/migrations');
  await migrate(drizzle(pg), { migrationsFolder });

  // 3. Set password for storeforge_app role inside ephemeral instance
  await pg.exec("ALTER ROLE storeforge_app WITH PASSWORD 'test_password'");

  // 4. Default wire session authorization
  await pg.exec('set session authorization storeforge_app');

  // 5. Start PGLite socket server
  const port = await getFreePort();
  const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
  await server.start();

  const url = `postgresql://storeforge_app:test_password@127.0.0.1:${port}/postgres`;

  return {
    url,
    pg,
    server,
    close: async () => {
      await server.stop();
      await pg.close();
    },
  };
}
