/**
 * npm run db:seed:demo
 *
 * Seeds ONE dedicated demo tenant ("urban-nest-demo") with products, variants, categories,
 * collections, customers, orders and an inventory ledger. Safe to re-run: every row has a
 * deterministic id and existing rows are skipped.
 *
 * Required:  SEED_DEMO_DATA=true and DIRECT_URL. Optional SEED_DEMO_USER_EMAIL (an existing confirmed user to own the
 * demo store); by default the dummy owner@demo.test / admin@demo.test / staff@demo.test logins are created.
 * Refuses to run when NODE_ENV or VERCEL_ENV is "production". Uses the privileged DIRECT_URL because
 * orders have no INSERT privilege for app roles; never import this from app code.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  assertSeedAllowed,
  DEMO_PASSWORD,
  DEMO_PLATFORM_ADMIN,
  DEMO_USERS,
  ensureDemoUsers,
  seedDemoData,
  verifyDemoData,
} from './lib/demo-seed.js';

try {
  process.loadEnvFile('.env');
} catch {
  // Variables may come from the real environment instead.
}

async function main() {
  const { directUrl, userEmail } = assertSeedAllowed(process.env);
  const host = new URL(directUrl).hostname;
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    ssl: isLocal ? false : 'require',
    connect_timeout: 15,
    onnotice: () => {},
  });
  try {
    const builtIn = DEMO_USERS.some((u) => u.email === userEmail.toLowerCase());
    if (builtIn) await ensureDemoUsers(drizzle(sql) as never);
    const users = await sql<
      { id: string }[]
    >`select id from auth.users where lower(email) = lower(${userEmail}) and email_confirmed_at is not null limit 1`;
    if (!users[0])
      throw new Error(
        `No confirmed Supabase Auth user with email ${userEmail}. Register and confirm it in the app first.`,
      );

    const db = drizzle(sql);
    const team = builtIn
      ? DEMO_USERS.filter((u) => u.role !== 'owner').map((u) => ({
          userId: u.id,
          role: u.role as 'admin' | 'staff',
        }))
      : [];
    const summary = await seedDemoData(
      db as never,
      users[0].id,
      new Date(),
      team,
    );
    console.log(
      `Demo tenant ${summary.tenantId} (${summary.tenantCreated ? 'created' : 'already existed'}) on ${host}`,
    );
    console.table(
      Object.fromEntries(
        Object.entries(summary.counts).map(([k, v]) => [k, v]),
      ),
    );

    const problems = await verifyDemoData(db as never, summary.tenantId);
    if (builtIn) {
      console.log(`
Demo logins (password for all: ${DEMO_PASSWORD}). Local/dev projects only.`);
      console.table(
        [...DEMO_USERS, { ...DEMO_PLATFORM_ADMIN, role: 'platform_admin' }].map(
          (u) => ({ role: u.role, email: u.email, password: DEMO_PASSWORD }),
        ),
      );
    }
    if (problems.length) {
      console.error('Consistency problems:\n - ' + problems.join('\n - '));
      process.exitCode = 1;
    } else console.log('Consistency checks passed.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('db:seed:demo failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
