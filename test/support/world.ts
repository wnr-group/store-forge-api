import {
  createPlatformAdmin,
  createUser,
  provision,
  type TestDb,
} from './pglite.js';

export interface World {
  superAdmin: string;
  admin: string;
  alice: string; // owner of A
  bob: string; // owner of B
  carol: string; // belongs to nothing
  tenantA: string;
  tenantB: string;
  storeA: string;
  storeB: string;
  members: Record<'reader' | 'writer' | 'nothing' | 'disabled', string>;
}

const PERMISSIONS = {
  reader: {
    products: 'read',
    orders: 'read',
    customers: 'read',
    settings: 'read',
  },
  writer: {
    products: 'write',
    orders: 'read',
    customers: 'write',
    settings: 'write',
  },
  nothing: {
    products: 'none',
    orders: 'none',
    customers: 'none',
    settings: 'read',
  },
  disabled: {
    products: 'write',
    orders: 'read',
    customers: 'write',
    settings: 'write',
  },
} as const;

/** Two organizations with an Owner each, members with different access, a lone user and two Platform Admins. */
export async function seedWorld(t: TestDb): Promise<World> {
  const superAdmin = await createPlatformAdmin(
    t,
    'super@example.test',
    'super_admin',
  );
  const admin = await createPlatformAdmin(t, 'admin@example.test', 'admin');
  const alice = await createUser(t, 'alice@example.test', 'Alice Owner');
  const bob = await createUser(t, 'bob@example.test', 'Bob Owner');
  const carol = await createUser(t, 'carol@example.test', 'Carol Nobody');
  const a = await provision(t, superAdmin, alice, 'alpha-shop');
  const b = await provision(t, superAdmin, bob, 'beta-shop');

  const members = {} as World['members'];
  for (const [name, permissions] of Object.entries(PERMISSIONS)) {
    const id = await createUser(t, `${name}@example.test`, `Member ${name}`);
    members[name as keyof World['members']] = id;
    await t.asOwner((pg) =>
      pg.query(
        "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'admin',$3::jsonb,$4)",
        [
          a.tenant_id,
          id,
          JSON.stringify(permissions),
          name === 'disabled' ? 'disabled' : 'active',
        ],
      ),
    );
  }
  return {
    superAdmin,
    admin,
    alice,
    bob,
    carol,
    tenantA: a.tenant_id,
    tenantB: b.tenant_id,
    storeA: a.store_id,
    storeB: b.store_id,
    members,
  };
}

/** Privileged inserts of data the API cannot create (orders are read-only for merchants). */
export async function insertOrder(
  t: TestDb,
  tenantId: string,
  customerId: string | null,
  orderNumber: number,
  status: string,
  totalMinor: number,
  items: { name: string; quantity: number; totalMinor: number }[] = [],
) {
  await t.asOwner(async (pg) => {
    const res = await pg.query<{ id: string }>(
      `insert into orders (tenant_id, customer_id, order_number, status, currency, subtotal_minor, total_minor)
       values ($1,$2,$3,$4,'INR',$5,$5) returning id`,
      [tenantId, customerId, orderNumber, status, totalMinor],
    );
    for (const i of items) {
      await pg.query(
        'insert into order_items (tenant_id, order_id, name, quantity, unit_price_minor, total_minor) values ($1,$2,$3,$4,$5,$6)',
        [
          tenantId,
          res.rows[0].id,
          i.name,
          i.quantity,
          Math.round(i.totalMinor / i.quantity),
          i.totalMinor,
        ],
      );
    }
  });
}
