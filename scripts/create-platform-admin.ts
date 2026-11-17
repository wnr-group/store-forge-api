/**
 * npm run admin:create -- --email you@example.com [--name "Your Name"]
 * PLATFORM_ADMIN_PASSWORD='<strong password>' is read from the ENVIRONMENT (never from argv or a file in git).
 *
 * Bootstraps a StoreForge Platform Admin - the only account type that can create companies:
 *   1. creates (or finds) the confirmed Supabase Auth user through the Admin Auth API
 *      (needs SUPABASE_SERVICE_ROLE_KEY + SUPABASE_URL), and
 *   2. inserts it into public.platform_admins over the privileged DIRECT_URL.
 * There is no web flow, API or SQL policy that can do step 2, so nobody can self-promote.
 * Run it from a trusted machine; unset the variables afterwards.
 * (Port of the Next.js repo's script; reads .env in this repo, SUPABASE_URL instead of NEXT_PUBLIC_SUPABASE_URL.)
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

try {
  process.loadEnvFile('.env');
} catch {
  // Variables may come from the real environment instead.
}

/**
 * `--name value`, `--name=value`, and a value split into several words by the shell (npm on Windows drops the quotes in
 * `--name "super admin"`): everything up to the next `--flag` belongs to the value.
 */
function arg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const words: string[] = [];
  for (const a of process.argv.slice(i + 1)) {
    if (a.startsWith('--')) break;
    words.push(a);
  }
  return words.join(' ');
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim() || 'Platform Admin';
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    DIRECT_URL: directUrl,
  } = process.env;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error('Pass a valid --email.');
  const missing = [
    ['SUPABASE_URL', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
    ['DIRECT_URL', directUrl],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length || !url || !serviceKey || !directUrl) {
    throw new Error(
      `Missing in the environment / .env: ${missing.join(', ')}. DIRECT_URL is the privileged postgres connection ` +
        '(direct or session pooler, port 5432), not DATABASE_URL (the app role cannot create admins).',
    );
  }

  const auth = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;

  // Find an existing user first (idempotent promote), else create a confirmed one.
  let userId: string | undefined;
  for (let page = 1; !userId; page++) {
    const { data, error } = await auth.listUsers({ page, perPage: 200 });
    if (error) throw error;
    userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
    if (data.users.length < 200) break;
  }
  if (!userId) {
    if (!password || password.length < 12)
      throw new Error(
        'Set PLATFORM_ADMIN_PASSWORD (at least 12 characters) in the environment.',
      );
    const { data, error } = await auth.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (error || !data.user)
      throw error ?? new Error('createUser returned no user');
    userId = data.user.id;
    console.log(`Created Auth user ${email}.`);
  } else {
    console.log(`Auth user ${email} already exists; promoting it.`);
  }

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(
    new URL(directUrl).hostname,
  );
  const sql = postgres(directUrl, {
    max: 1,
    prepare: false,
    ssl: isLocal ? false : 'require',
    connect_timeout: 15,
    onnotice: () => {},
  });
  try {
    // The bootstrap account is a super admin: it can add other admins and edit the platform settings.
    await sql`insert into public.platform_admins (user_id, role) values (${userId}, 'super_admin') on conflict (user_id) do update set role = 'super_admin'`;
    console.log(
      `${email} is a Platform Admin. Sign in with the Supabase SDK, then call GET /api/v1/platform/me with the access token.`,
    );
  } catch (e) {
    // A tenant member cannot also be a Platform Admin (database trigger).
    if (userId && String(e).includes('member_cannot_be_platform_admin'))
      throw new Error(
        `${email} is already a company member. Use a separate account for platform administration.`,
      );
    throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('admin:create failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
