/**
 * Writes the demo plan into ONE dedicated demo tenant, inside a single transaction.
 *
 * Why a privileged connection: `orders` / `order_items` have no INSERT privilege for `authenticated`
 * (there is no checkout yet), and inventory timestamps/ids are set explicitly. The runner therefore
 * uses DIRECT_URL, exactly like scripts/seed.ts. RLS is never disabled or altered; the tenant and its
 * owner membership are created through the supported onboarding function while acting as the demo user.
 */
import { sql } from 'drizzle-orm';
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
} from 'drizzle-orm/pg-core';
import {
  categories,
  collectionProducts,
  collections,
  customers,
  inventoryAdjustments,
  orderItems,
  orders,
  productOptions,
  products,
  productVariants,
  stores,
} from '../../src/database/schema/index.js';
import { rowsOf } from '../../src/database/user-context.js';
import { buildDemoPlan, DEMO_STORE, DEMO_TENANT_NAME } from './demo-data.js';

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
/** Dummy logins for LOCAL/DEV projects only. The password is public; never use these anywhere real. */
const DEMO_MANAGER_PERMISSIONS = {
  products: 'write',
  orders: 'write',
  customers: 'write',
  settings: 'write',
};
const DEMO_STAFF_PERMISSIONS = {
  products: 'write',
  orders: 'read',
  customers: 'write',
  settings: 'read',
};

export const DEMO_PASSWORD = 'Demo1234';
export const DEMO_USERS = [
  {
    id: 'd0000000-0000-4000-8000-000000000001',
    email: 'owner@demo.test',
    name: 'Olivia Owner',
    role: 'owner',
  },
  {
    id: 'd0000000-0000-4000-8000-000000000002',
    email: 'admin@demo.test',
    name: 'Arun Admin',
    role: 'admin',
  },
  {
    id: 'd0000000-0000-4000-8000-000000000003',
    email: 'staff@demo.test',
    name: 'Sana Staff',
    role: 'staff',
  },
] as const;
/** The Platform Admin who provisions the demo company (signs in at /login and lands on /admin). */
export const DEMO_PLATFORM_ADMIN = {
  id: 'd0000000-0000-4000-8000-000000000004',
  email: 'platform@demo.test',
  name: 'Priya Platform',
} as const;
const DEMO_LOGINS = [...DEMO_USERS, DEMO_PLATFORM_ADMIN];

/**
 * Creates the dummy Auth users (same technique as scripts/seed.sql: the hosted project has no
 * service-role key in this app). Idempotent. The on_auth_user_created trigger creates their profiles.
 */
export async function ensureDemoUsers(db: Db): Promise<void> {
  await db.execute(
    sql.raw('create extension if not exists pgcrypto with schema extensions'),
  );
  for (const u of DEMO_LOGINS) {
    await db.execute(sql`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change, email_change_token_new)
      values ('00000000-0000-0000-0000-000000000000', ${u.id}::uuid, 'authenticated', 'authenticated', ${u.email},
        extensions.crypt(${DEMO_PASSWORD}, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, ${JSON.stringify({ full_name: u.name })}::jsonb,
        now(), now(), '', '', '', '')
      on conflict (id) do nothing`);
    await db.execute(sql`
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), ${u.id}::uuid, ${u.id}, 'email',
        ${JSON.stringify({ sub: u.id, email: u.email, email_verified: true })}::jsonb, now(), now(), now())
      on conflict do nothing`);
  }
}

export type Counts = { inserted: number; skipped: number };
export type SeedSummary = {
  tenantId: string;
  tenantCreated: boolean;
  counts: Record<string, Counts>;
  storeUpdated: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless every guard passes. Pure, so it is unit-testable. */
export function assertSeedAllowed(env: Record<string, string | undefined>): {
  directUrl: string;
  userEmail: string;
} {
  if (env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production') {
    throw new Error(
      'Refusing to seed demo data: this looks like a production environment.',
    );
  }
  if (env.SEED_DEMO_DATA !== 'true') {
    throw new Error(
      'Refusing to seed demo data: set SEED_DEMO_DATA=true to confirm you want to write demo data.',
    );
  }
  if (!env.DIRECT_URL)
    throw new Error(
      'DIRECT_URL is required (the privileged connection used for migrations).',
    );
  // Without SEED_DEMO_USER_EMAIL the built-in dummy owner is used (and created if missing).
  return {
    directUrl: env.DIRECT_URL,
    userEmail: env.SEED_DEMO_USER_EMAIL?.trim() || DEMO_USERS[0].email,
  };
}

async function insertAll(
  tx: Db,
  table: PgTable,
  rows: Record<string, unknown>[],
): Promise<Counts> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const done = await tx
      .insert(table)
      .values(rows.slice(i, i + 500) as never)
      .onConflictDoNothing()
      .returning();
    inserted += done.length;
  }
  return { inserted, skipped: rows.length - inserted };
}

export async function seedDemoData(
  db: Db,
  userId: string,
  now = new Date(),
  team: { userId: string; role: 'admin' | 'staff' }[] = [],
): Promise<SeedSummary> {
  if (!UUID.test(userId))
    throw new Error('seedDemoData: userId must be a UUID');
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;

    // 1. Provision the company as the demo Platform Admin (the only way tenants are created), then drop back to the owner role.
    await t.execute(
      sql`insert into public.platform_admins (user_id, role) values (${DEMO_PLATFORM_ADMIN.id}::uuid, 'super_admin') on conflict do nothing`,
    );
    const claims = JSON.stringify({
      sub: DEMO_PLATFORM_ADMIN.id,
      role: 'authenticated',
    });
    await t.execute(
      sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${DEMO_PLATFORM_ADMIN.id}, true)`,
    );
    await t.execute(sql.raw('set local role authenticated'));
    const [onboard] = rowsOf<{
      r: { tenant_id: string; created: boolean } | string;
    }>(
      await t.execute(
        sql`select public.platform_provision_tenant(${userId}::uuid, ${DEMO_TENANT_NAME}, ${DEMO_STORE.name}, ${DEMO_STORE.slug}, ${DEMO_STORE.description}) as r`,
      ),
    );
    await t.execute(sql.raw('reset role'));
    const result =
      typeof onboard.r === 'string'
        ? (JSON.parse(onboard.r) as { tenant_id: string; created: boolean })
        : onboard.r;
    const tenantId = result.tenant_id;

    // 2. Hard guard: only ever write into a tenant this user owns and whose store is the demo store.
    const owner = rowsOf<{ ok: number }>(
      await t.execute(sql`select 1 as ok from public.memberships m join public.stores s on s.tenant_id = m.tenant_id
        where m.tenant_id = ${tenantId} and m.user_id = ${userId} and m.role = 'owner' and s.slug = ${DEMO_STORE.slug}`),
    );
    if (owner.length !== 1)
      throw new Error(
        'Demo tenant ownership check failed; nothing was written.',
      );

    for (const m of team) {
      // Demo team presets: the manager can change everything, the staff member everything but orders and settings.
      const permissions =
        m.role === 'admin' ? DEMO_MANAGER_PERMISSIONS : DEMO_STAFF_PERMISSIONS;
      await t.execute(
        sql`insert into public.memberships (tenant_id, user_id, role, permissions) values (${tenantId}, ${m.userId}::uuid, ${m.role}, ${JSON.stringify(permissions)}::jsonb) on conflict (tenant_id, user_id) do nothing`,
      );
    }

    const plan = buildDemoPlan(tenantId, userId, now);

    // 3. Store profile and settings for the demo store only.
    await t
      .update(stores)
      .set({
        description: DEMO_STORE.description,
        contactEmail: DEMO_STORE.contactEmail,
        contactPhone: DEMO_STORE.contactPhone,
        currency: DEMO_STORE.currency,
        timezone: DEMO_STORE.timezone,
      })
      .where(
        sql`${stores.tenantId} = ${tenantId} and ${stores.slug} = ${DEMO_STORE.slug}`,
      );

    // 4. Parents before children.
    const counts: Record<string, Counts> = {};
    // Categories: roots first so the parent_id FK is satisfied.
    const roots = plan.categories.filter((c) => !c.parentId);
    const children = plan.categories.filter((c) => c.parentId);
    const a = await insertAll(t, categories, roots);
    const b = await insertAll(t, categories, children);
    counts.categories = {
      inserted: a.inserted + b.inserted,
      skipped: a.skipped + b.skipped,
    };
    counts.products = await insertAll(t, products, plan.products);
    counts.productOptions = await insertAll(t, productOptions, plan.options);
    counts.productVariants = await insertAll(t, productVariants, plan.variants);
    counts.collections = await insertAll(t, collections, plan.collections);
    counts.collectionProducts = await insertAll(
      t,
      collectionProducts,
      plan.collectionProducts,
    );
    counts.customers = await insertAll(t, customers, plan.customers);
    counts.orders = await insertAll(t, orders, plan.orders);
    counts.orderItems = await insertAll(t, orderItems, plan.orderItems);
    counts.inventoryAdjustments = await insertAll(
      t,
      inventoryAdjustments,
      plan.adjustments,
    );

    return {
      tenantId,
      tenantCreated: result.created,
      counts,
      storeUpdated: true,
    };
  });
}

/** Read-only consistency checks over the seeded tenant. Returns problems; empty means consistent. */
export async function verifyDemoData(
  db: Db,
  tenantId: string,
): Promise<string[]> {
  const q = async (label: string, query: ReturnType<typeof sql>) => {
    const n = Number(rowsOf<{ n: number }>(await db.execute(query))[0]?.n ?? 0);
    return n === 0 ? [] : [`${label}: ${n}`];
  };
  const T = tenantId;
  return (
    await Promise.all([
      q(
        'orders whose total differs from line items',
        sql`select count(*)::int n from public.orders o where o.tenant_id = ${T} and o.subtotal_minor <> (select coalesce(sum(total_minor),0) from public.order_items i where i.order_id = o.id)`,
      ),
      q(
        'order totals differing from subtotal',
        sql`select count(*)::int n from public.orders where tenant_id = ${T} and total_minor <> subtotal_minor`,
      ),
      q(
        'line totals != qty * unit price',
        sql`select count(*)::int n from public.order_items where tenant_id = ${T} and total_minor <> quantity * unit_price_minor`,
      ),
      q(
        'order items without a product',
        sql`select count(*)::int n from public.order_items where tenant_id = ${T} and product_id is null`,
      ),
      q(
        'order variants not belonging to their product',
        sql`select count(*)::int n from public.order_items i where i.tenant_id = ${T} and i.variant_id is not null and not exists (select 1 from public.product_variants v where v.id = i.variant_id and v.product_id = i.product_id)`,
      ),
      q(
        'orders without a customer',
        sql`select count(*)::int n from public.orders where tenant_id = ${T} and customer_id is null`,
      ),
      q(
        'orders outside the previous 90 days',
        sql`select count(*)::int n from public.orders where tenant_id = ${T} and (placed_at < now() - interval '91 days' or placed_at > now())`,
      ),
      q(
        'units whose ledger does not end at their quantity',
        sql`
        select count(*)::int n from (
          select p.id pid, null::uuid vid, p.quantity qty from public.products p where p.tenant_id = ${T} and not p.has_variants
          union all select v.product_id, v.id, v.quantity from public.product_variants v where v.tenant_id = ${T}) u
        where coalesce((select a.quantity_after from public.inventory_adjustments a where a.product_id = u.pid and a.variant_id is not distinct from u.vid order by a.created_at desc, a.quantity_after limit 1), -1) <> u.qty`,
      ),
      q(
        'rows belonging to another tenant',
        sql`select count(*)::int n from public.order_items i join public.orders o on o.id = i.order_id where i.tenant_id = ${T} and o.tenant_id <> ${T}`,
      ),
    ])
  ).flat();
}
