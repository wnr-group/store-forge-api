import type { PGlite } from '@electric-sql/pglite';
import type { PlatformAdminRole } from '../../../src/database/schema/enums.js';

export async function withSuperuser<T>(
  pg: PGlite,
  fn: () => Promise<T>,
): Promise<T> {
  await pg.exec('set session authorization postgres');
  try {
    return await fn();
  } finally {
    await pg.exec('set session authorization storeforge_app').catch(() => {});
  }
}

export async function createUser(
  pg: PGlite,
  opts: { email: string; fullName?: string },
): Promise<string> {
  return withSuperuser(pg, async () => {
    const meta = JSON.stringify(
      opts.fullName ? { full_name: opts.fullName } : {},
    );
    const res = await pg.query<{ id: string }>(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
      [opts.email, meta],
    );
    return res.rows[0].id;
  });
}

export async function asUser<T>(
  pg: PGlite,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const claims = userId
    ? JSON.stringify({ sub: userId, role: 'authenticated' })
    : '{}';
  await pg.exec('set session authorization postgres');
  try {
    await pg.query("select set_config('request.jwt.claims', $1, false)", [
      claims,
    ]);
    await pg.exec(`set role ${userId ? 'authenticated' : 'anon'}`);
    return await fn();
  } finally {
    await pg.exec('reset role').catch(() => {});
    await pg
      .query("select set_config('request.jwt.claims', '', false)")
      .catch(() => {});
    await pg.exec('set session authorization storeforge_app').catch(() => {});
  }
}

export async function createPlatformAdmin(
  pg: PGlite,
  opts: { email?: string; role?: PlatformAdminRole } = {},
): Promise<string> {
  return withSuperuser(pg, async () => {
    const email = opts.email ?? 'platform.admin@example.test';
    const role = opts.role ?? 'super_admin';

    const existing = await pg.query<{ id: string }>(
      'select id from auth.users where email = $1',
      [email],
    );
    let id: string;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
    } else {
      const meta = JSON.stringify({ full_name: 'Platform Admin' });
      const res = await pg.query<{ id: string }>(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
        [email, meta],
      );
      id = res.rows[0].id;
    }

    await pg.query(
      'insert into platform_admins (user_id, role) values ($1, $2) on conflict do nothing',
      [id, role],
    );
    return id;
  });
}

export async function createTenantWithOwner(
  pg: PGlite,
  opts: {
    ownerId: string;
    storeSlug: string;
    tenantName?: string;
    storeName?: string;
  },
): Promise<{ tenantId: string; storeId: string; storeSlug: string }> {
  const adminId = await createPlatformAdmin(pg);
  return asUser(pg, adminId, async () => {
    const res = await pg.query<{
      r: {
        tenant_id: string;
        store_id: string;
        store_slug: string;
        created: boolean;
      };
    }>('select public.platform_provision_tenant($1, $2, $3, $4) as r', [
      opts.ownerId,
      opts.tenantName ?? `${opts.storeSlug} Inc`,
      opts.storeName ?? `${opts.storeSlug} Store`,
      opts.storeSlug,
    ]);
    const r = res.rows[0].r;
    return {
      tenantId: r.tenant_id,
      storeId: r.store_id,
      storeSlug: r.store_slug,
    };
  });
}

export async function addMember(
  pg: PGlite,
  opts: {
    tenantId: string;
    userId: string;
    role?: 'admin' | 'staff';
    permissions?: Record<string, string>;
    status?: 'active' | 'disabled';
  },
): Promise<string> {
  return withSuperuser(pg, async () => {
    const permissions = JSON.stringify(
      opts.permissions ?? {
        products: 'write',
        orders: 'write',
        customers: 'write',
        settings: 'write',
      },
    );
    const res = await pg.query<{ id: string }>(
      `insert into public.memberships (tenant_id, user_id, role, permissions, status)
       values ($1, $2, $3, $4::jsonb, $5)
       returning id`,
      [
        opts.tenantId,
        opts.userId,
        opts.role ?? 'admin',
        permissions,
        opts.status ?? 'active',
      ],
    );
    return res.rows[0].id;
  });
}
