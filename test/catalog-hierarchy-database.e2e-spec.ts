import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorChain } from '../src/common/db-errors.js';
import { rowsOf } from '../src/database/database.service.js';
import {
  asUser,
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

/** Drizzle wraps the driver error in a generic "Failed query" error; the database message is in the cause chain. */
async function failsWith(work: Promise<unknown>, expected: RegExp) {
  let error: unknown;
  try {
    await work;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected the statement to fail').toBeDefined();
  expect(errorChain(error)).toMatch(expected);
}

/**
 * Catalog hierarchy, database layer (migrations 0072 / 0073): tenant isolation, RLS, column grants and the integrity
 * triggers, exercised through the REAL request path (SET LOCAL ROLE authenticated + the user's id).
 */
describe.skipIf(!migrationsAvailable)(
  'catalog hierarchy database rules (e2e)',
  () => {
    let db: TestDb;
    let w: World;
    let hierarchyA: string;
    const level: Record<'brand' | 'vehicle' | 'variant', string> = {
      brand: '',
      vehicle: '',
      variant: '',
    };
    let hierarchyB: string;
    let levelB1: string;

    /** Runs SQL as a user; resolves to the rows. */
    const run = <T = Record<string, unknown>>(user: string, query: string) =>
      asUser(db, user, async (tx) =>
        rowsOf<T>(await tx.execute(sql.raw(query))),
      );
    const owner = async <T = Record<string, unknown>>(
      query: string,
      params: unknown[] = [],
    ) => db.asOwner(async (pg) => (await pg.query<T>(query, params)).rows);

    const node = async (
      user: string,
      tenant: string,
      hierarchy: string,
      levelId: string,
      name: string,
      parent: string | null = null,
    ) =>
      (
        await run<{ id: string }>(
          user,
          `insert into catalog_nodes (tenant_id, hierarchy_id, level_id, parent_id, name, slug, status)
         values ('${tenant}', '${hierarchy}', '${levelId}', ${parent ? `'${parent}'` : 'null'}, '${name}', '${name.toLowerCase().replace(/ /g, '-')}', 'active')
         returning id`,
        )
      )[0].id;

    beforeAll(async () => {
      db = await createTestDb();
      w = await seedWorld(db);
      hierarchyA = (
        await run<{ id: string }>(
          w.alice,
          `insert into catalog_hierarchies (tenant_id, name) values ('${w.tenantA}', 'Parts') returning id`,
        )
      )[0].id;
      for (const [i, key] of (
        ['brand', 'vehicle', 'variant'] as const
      ).entries())
        level[key] = (
          await run<{ id: string }>(
            w.alice,
            `insert into catalog_levels (tenant_id, hierarchy_id, name, position, can_hold_products)
           values ('${w.tenantA}', '${hierarchyA}', '${key}', ${i + 1}, ${key === 'variant'}) returning id`,
          )
        )[0].id;
      hierarchyB = (
        await run<{ id: string }>(
          w.bob,
          `insert into catalog_hierarchies (tenant_id, name) values ('${w.tenantB}', 'Other') returning id`,
        )
      )[0].id;
      levelB1 = (
        await run<{ id: string }>(
          w.bob,
          `insert into catalog_levels (tenant_id, hierarchy_id, name, position) values ('${w.tenantB}', '${hierarchyB}', 'Top', 1) returning id`,
        )
      )[0].id;
    });
    afterAll(async () => {
      await db?.close();
    });

    describe('tenant isolation and RLS', () => {
      it('an organization sees only its own hierarchy rows', async () => {
        const a = await run<{ id: string }>(
          w.alice,
          'select id from catalog_hierarchies',
        );
        expect(a.map((r) => r.id)).toEqual([hierarchyA]);
        const b = await run<{ id: string }>(
          w.bob,
          'select id from catalog_levels',
        );
        expect(b.map((r) => r.id)).toEqual([levelB1]);
      });

      it('only one hierarchy per organization (for now)', async () => {
        await failsWith(
          run(
            w.alice,
            `insert into catalog_hierarchies (tenant_id, name) values ('${w.tenantA}', 'Second')`,
          ),
          /catalog_hierarchies_one_per_tenant_idx/,
        );
      });

      it("a user cannot write into another organization's hierarchy (RLS)", async () => {
        await failsWith(
          run(
            w.bob,
            `insert into catalog_levels (tenant_id, hierarchy_id, name, position) values ('${w.tenantA}', '${hierarchyA}', 'Evil', 9)`,
          ),
          /row-level security|permission denied/,
        );
      });

      it('composite foreign keys stop a cross-tenant link even for the privileged owner role', async () => {
        // a level of tenant B inside tenant A's hierarchy
        await failsWith(
          owner(
            `insert into catalog_levels (tenant_id, hierarchy_id, name, position) values ('${w.tenantB}', '${hierarchyA}', 'x', 9)`,
          ),
          /catalog_levels_hierarchy_fk/,
        );
        // a node of tenant A using a level of tenant B
        await failsWith(
          owner(
            `insert into catalog_nodes (tenant_id, hierarchy_id, level_id, name, slug) values ('${w.tenantA}', '${hierarchyA}', '${levelB1}', 'x', 'x')`,
          ),
          /CATALOG_LEVEL_NOT_FOUND|catalog_nodes_level_fk/,
        );
      });

      it('a product of another organization cannot be linked to a node (composite foreign key)', async () => {
        const nodeId = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Iso Brand',
        );
        // brand level cannot hold products, so make a holder to test the FK rather than the level rule
        const veh = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Iso Vehicle',
          nodeId,
        );
        const holder = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.variant,
          'Iso Variant',
          veh,
        );
        const [p] = await owner<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor) values ('${w.tenantB}', 'Bob product', 'bob-product-iso', 100) returning id`,
        );
        await failsWith(
          owner(
            `insert into catalog_node_products (tenant_id, node_id, product_id) values ('${w.tenantA}', '${holder}', '${p.id}')`,
          ),
          /catalog_node_products_product_fk/,
        );
      });

      it('a read-only member can read but not write; a member without Products access sees nothing', async () => {
        const seen = await run(
          w.members.reader,
          'select id from catalog_hierarchies',
        );
        expect(seen).toHaveLength(1);
        await failsWith(
          run(
            w.members.reader,
            `insert into catalog_levels (tenant_id, hierarchy_id, name, position) values ('${w.tenantA}', '${hierarchyA}', 'R', 9)`,
          ),
          /row-level security|permission denied/,
        );
        expect(
          await run(w.members.nothing, 'select id from catalog_hierarchies'),
        ).toHaveLength(0);
        expect(
          await run(w.members.nothing, 'select id from catalog_nodes'),
        ).toHaveLength(0);
        // a writer may
        await run(
          w.members.writer,
          `update catalog_hierarchies set name = 'Parts' where id = '${hierarchyA}'`,
        );
      });

      it('column grants: the client can never write tenant_id, path_ids or depth of a node, or the level of an existing node', async () => {
        const id = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Grant Brand',
        );
        for (const col of [
          'path_ids',
          'depth',
          'tenant_id',
          'level_id',
          'hierarchy_id',
        ])
          await failsWith(
            run(
              w.alice,
              `update catalog_nodes set ${col} = ${col} where id = '${id}'`,
            ),
            /permission denied/,
          );
      });

      it('an anonymous request (no user) sees no rows at all', async () => {
        const rows = await db.service.withPublic(async (tx) =>
          rowsOf(await tx.execute(sql`select * from catalog_nodes`)),
        );
        expect(rows).toHaveLength(0);
      });
    });

    describe('node integrity', () => {
      it('a root must be on level 1, a child exactly one level below its parent', async () => {
        await failsWith(
          node(w.alice, w.tenantA, hierarchyA, level.vehicle, 'Bad Root'),
          /CATALOG_NODE_LEVEL_MISMATCH/,
        );
        const b = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Rule Brand',
        );
        await failsWith(
          node(w.alice, w.tenantA, hierarchyA, level.variant, 'Skip', b),
          /CATALOG_NODE_LEVEL_MISMATCH/,
        );
        await failsWith(
          node(w.alice, w.tenantA, hierarchyA, level.brand, 'Same Level', b),
          /CATALOG_NODE_LEVEL_MISMATCH/,
        );
      });

      it('keeps path and depth, and re-paths the whole subtree when a node moves', async () => {
        const b1 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Move Brand One',
        );
        const b2 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Move Brand Two',
        );
        const veh = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Moving Vehicle',
          b1,
        );
        const variant = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.variant,
          'Moving Variant',
          veh,
        );
        const before = (
          await run<{ depth: number; path_ids: string[] }>(
            w.alice,
            `select depth, path_ids from catalog_nodes where id = '${variant}'`,
          )
        )[0];
        expect(before.depth).toBe(3);
        expect(before.path_ids).toEqual([b1, veh, variant]);
        await run(
          w.alice,
          `update catalog_nodes set parent_id = '${b2}' where id = '${veh}'`,
        );
        const after = (
          await run<{ depth: number; path_ids: string[] }>(
            w.alice,
            `select depth, path_ids from catalog_nodes where id = '${variant}'`,
          )
        )[0];
        expect(after.depth).toBe(3);
        expect(after.path_ids).toEqual([b2, veh, variant]);
      });

      it('rejects a move into a level that does not fit, a move under its own descendant, and a self parent', async () => {
        const b = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Cycle Brand',
        );
        const v = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Cycle Vehicle',
          b,
        );
        await failsWith(
          run(
            w.alice,
            `update catalog_nodes set parent_id = '${v}' where id = '${b}'`,
          ),
          /CATALOG_NODE_LEVEL_MISMATCH|CATALOG_NODE_CYCLE/,
        );
        await failsWith(
          run(
            w.alice,
            `update catalog_nodes set parent_id = id where id = '${v}'`,
          ),
          /catalog_nodes_parent_check|CATALOG_NODE_CYCLE/,
        );
        // privileged cycle attempt: the trigger still refuses it
        await failsWith(
          owner(
            `update catalog_nodes set parent_id = '${v}' where id = '${b}'`,
          ),
          /CATALOG_NODE_LEVEL_MISMATCH|CATALOG_NODE_CYCLE/,
        );
        await failsWith(
          owner(
            `update catalog_nodes set level_id = '${level.vehicle}' where id = '${b}'`,
          ),
          /CATALOG_NODE_LEVEL_IMMUTABLE/,
        );
      });

      it('a path or depth sent by the client on insert never sticks: the trigger always computes them', async () => {
        const root = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Forge Brand',
        );
        const id = crypto.randomUUID();
        await run(
          w.alice,
          `insert into catalog_nodes (id, tenant_id, hierarchy_id, level_id, parent_id, name, slug, path_ids, depth)
           values ('${id}', '${w.tenantA}', '${hierarchyA}', '${level.vehicle}', '${root}', 'Forge Vehicle', 'forge-vehicle',
                   array['${crypto.randomUUID()}', '${id}']::uuid[], 2)`,
        );
        const [row] = await run<{ path_ids: string[]; depth: number }>(
          w.alice,
          `select path_ids, depth from catalog_nodes where id = '${id}'`,
        );
        expect(row.path_ids).toEqual([root, id]);
        expect(row.depth).toBe(2);
      });

      it('slugs are unique among siblings (including roots), but may repeat under different parents', async () => {
        const b1 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Slug Brand A',
        );
        const b2 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Slug Brand B',
        );
        await failsWith(
          node(w.alice, w.tenantA, hierarchyA, level.brand, 'Slug Brand A'),
          /catalog_nodes_root_slug_key/,
        );
        await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Same Name',
          b1,
        );
        await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Same Name',
          b2,
        );
        await failsWith(
          node(w.alice, w.tenantA, hierarchyA, level.vehicle, 'Same Name', b1),
          /catalog_nodes_child_slug_key/,
        );
      });

      it('a parent with children cannot be deleted one row at a time, but a whole subtree can in one statement', async () => {
        const b = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'Del Brand',
        );
        const v = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'Del Vehicle',
          b,
        );
        await failsWith(
          run(w.alice, `delete from catalog_nodes where id = '${b}'`),
          /catalog_nodes_parent_fk/,
        );
        await run(
          w.alice,
          `delete from catalog_nodes where '${b}' = any (path_ids)`,
        );
        expect(
          await run(
            w.alice,
            `select 1 from catalog_nodes where id in ('${b}', '${v}')`,
          ),
        ).toHaveLength(0);
      });
    });

    describe('level order', () => {
      let h: string;
      let l: string[];
      beforeAll(async () => {
        // Bob's organization gets a four level hierarchy of its own, so these tests never disturb Alice's data.
        await run(w.bob, `delete from catalog_levels where id = '${levelB1}'`);
        h = hierarchyB;
        l = [];
        for (const [i, name] of ['One', 'Two', 'Three', 'Four'].entries())
          l.push(
            (
              await run<{ id: string }>(
                w.bob,
                `insert into catalog_levels (tenant_id, hierarchy_id, name, position, can_hold_products) values ('${w.tenantB}', '${h}', '${name}', ${i + 1}, true) returning id`,
              )
            )[0].id,
          );
      });

      const positions = async () =>
        (
          await run<{ name: string; position: number }>(
            w.bob,
            `select name, position from catalog_levels where hierarchy_id = '${h}' order by position`,
          )
        ).map((r) => r.name);

      it('empty levels can be reordered with one statement (a swap)', async () => {
        await run(
          w.bob,
          `update catalog_levels set position = case id when '${l[2]}' then 4 when '${l[3]}' then 3 end where id in ('${l[2]}', '${l[3]}')`,
        );
        expect(await positions()).toEqual(['One', 'Two', 'Four', 'Three']);
      });

      it('a numbering with a gap or a duplicate is refused', async () => {
        await failsWith(
          run(
            w.bob,
            `update catalog_levels set position = 7 where id = '${l[0]}'`,
          ),
          /CATALOG_LEVEL_NUMBERING/,
        );
        await failsWith(
          run(
            w.bob,
            `update catalog_levels set position = 2 where id = '${l[0]}'`,
          ),
          /catalog_levels_position_key/,
        );
      });

      it('a reorder that would break existing parent/child relations is refused; one that keeps them is allowed', async () => {
        const sorted = [l[0], l[1], l[3], l[2]]; // current order after the swap above
        const root = await node(w.bob, w.tenantB, h, sorted[0], 'Order Root');
        const child = await node(
          w.bob,
          w.tenantB,
          h,
          sorted[1],
          'Order Child',
          root,
        );
        // swapping the two populated levels would invert the tree
        await failsWith(
          run(
            w.bob,
            `update catalog_levels set position = case id when '${sorted[0]}' then 2 when '${sorted[1]}' then 1 end where id in ('${sorted[0]}', '${sorted[1]}')`,
          ),
          /CATALOG_LEVEL_ORDER_BLOCKED/,
        );
        // swapping the two empty levels below is fine and leaves the tree alone
        await run(
          w.bob,
          `update catalog_levels set position = case id when '${sorted[2]}' then 4 when '${sorted[3]}' then 3 end where id in ('${sorted[2]}', '${sorted[3]}')`,
        );
        const rows = await run<{ depth: number }>(
          w.bob,
          `select depth from catalog_nodes where id = '${child}'`,
        );
        expect(rows[0].depth).toBe(2);
        // a level with nodes cannot be deleted
        await failsWith(
          run(w.bob, `delete from catalog_levels where id = '${sorted[0]}'`),
          /catalog_nodes_level_fk|CATALOG_LEVEL_NUMBERING/,
        );
      });

      it('the last level can be deleted; a level that still has nodes cannot', async () => {
        const rows = await run<{ id: string; position: number }>(
          w.bob,
          `select id, position from catalog_levels where hierarchy_id = '${h}' order by position`,
        );
        await run(
          w.bob,
          `delete from catalog_levels where id = '${rows[3].id}'`,
        );
        await failsWith(
          run(w.bob, `delete from catalog_levels where id = '${rows[1].id}'`),
          /catalog_nodes_level_fk/,
        );
      });
    });

    describe('products on nodes', () => {
      it('products can only be linked to nodes whose level allows them; many nodes per product, many products per node', async () => {
        const b = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.brand,
          'P Brand',
        );
        const v1 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'P Vehicle 1',
          b,
        );
        const v2 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.vehicle,
          'P Vehicle 2',
          b,
        );
        const s1 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.variant,
          'P Variant 1',
          v1,
        );
        const s2 = await node(
          w.alice,
          w.tenantA,
          hierarchyA,
          level.variant,
          'P Variant 2',
          v2,
        );
        const [p1, p2] = await owner<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, part_number) values
             ('${w.tenantA}', 'Part 1', 'part-one', 100, 'PN-1'), ('${w.tenantA}', 'Part 2', 'part-two', 100, 'PN-1') returning id`,
        );
        // the vehicle level does not hold products
        await failsWith(
          run(
            w.alice,
            `insert into catalog_node_products (tenant_id, node_id, product_id) values ('${w.tenantA}', '${v1}', '${p1.id}')`,
          ),
          /CATALOG_LEVEL_CANNOT_HOLD_PRODUCTS/,
        );
        await run(
          w.alice,
          `insert into catalog_node_products (tenant_id, node_id, product_id) values
             ('${w.tenantA}', '${s1}', '${p1.id}'), ('${w.tenantA}', '${s2}', '${p1.id}'), ('${w.tenantA}', '${s1}', '${p2.id}')`,
        );
        // the same product on the same node twice is refused
        await failsWith(
          run(
            w.alice,
            `insert into catalog_node_products (tenant_id, node_id, product_id) values ('${w.tenantA}', '${s1}', '${p1.id}')`,
          ),
          /catalog_node_products_pkey/,
        );
        // part_number is NOT unique (both products have PN-1), the product itself exists once
        const dup = await owner(
          `select count(*)::int as n from products where part_number = 'PN-1' and tenant_id = '${w.tenantA}'`,
        );
        expect(dup[0]).toMatchObject({ n: 2 });
        // the variant level cannot be switched to "no products" while products are linked
        await failsWith(
          run(
            w.alice,
            `update catalog_levels set can_hold_products = false where id = '${level.variant}'`,
          ),
          /CATALOG_LEVEL_HAS_PRODUCTS/,
        );
        // deleting the product removes its links
        await run(w.alice, `delete from products where id = '${p2.id}'`);
        expect(
          await run(
            w.alice,
            `select 1 from catalog_node_products where product_id = '${p2.id}'`,
          ),
        ).toHaveLength(0);
        // deleting a node removes its links but not the product
        await run(w.alice, `delete from catalog_nodes where id = '${s2}'`);
        expect(
          await run(w.alice, `select 1 from products where id = '${p1.id}'`),
        ).toHaveLength(1);
      });

      it('part_number is limited to 64 characters', async () => {
        await failsWith(
          owner(
            `insert into products (tenant_id, name, slug, price_minor, part_number) values ('${w.tenantA}', 'Long', 'long-pn', 1, '${'x'.repeat(65)}')`,
          ),
          /products_part_number_check/,
        );
      });
    });
  },
);
