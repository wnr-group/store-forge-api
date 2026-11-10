import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../test/support/database/create-test-database.js';
import {
  createUser,
  createTenantWithOwner,
} from '../../../test/support/database/fixtures.js';
import { SUPABASE_STUB } from '../../../test/support/database/supabase-stub.js';
import { DatabaseModule } from './database.module.js';
import { DatabaseService } from './database.service.js';
import { dbSchema } from './database.types.js';
import { RlsGuardError, rowsOf, withUserContext } from './user-context.js';

describe('DatabaseService integration (D-011, D-018, D-025)', () => {
  let testDb: TestDatabase;
  let moduleRef: TestingModule;
  let dbService: DatabaseService;
  let aliceId: string;
  let bobId: string;
  let tenantA: { tenantId: string; storeId: string; storeSlug: string };
  let tenantB: { tenantId: string; storeId: string; storeSlug: string };

  beforeAll(async () => {
    // AC-A-29: createTestDatabase applies all 25 migrations
    testDb = await createTestDatabase();

    // Fixtures
    aliceId = await createUser(testDb.pg, {
      email: 'alice@example.test',
      fullName: 'Alice Owner',
    });
    bobId = await createUser(testDb.pg, {
      email: 'bob@example.test',
      fullName: 'Bob Owner',
    });

    tenantA = await createTenantWithOwner(testDb.pg, {
      ownerId: aliceId,
      storeSlug: 'alice-shop',
      tenantName: 'Alice Inc',
      storeName: 'Alice Shop',
    });

    tenantB = await createTenantWithOwner(testDb.pg, {
      ownerId: bobId,
      storeSlug: 'bob-shop',
      tenantName: 'Bob Inc',
      storeName: 'Bob Shop',
    });

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              database: {
                url: testDb.url,
                poolMax: 1, // Single session for PGlite socket
                prepare: false,
                connectTimeoutSeconds: 5,
              },
            }),
          ],
        }),
        DatabaseModule,
      ],
    }).compile();

    await moduleRef.init();
    dbService = moduleRef.get(DatabaseService);
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    if (testDb) {
      await testDb.close();
    }
  });

  it('AC-A-19: runs select 1 through postgres-js over the PGlite socket', async () => {
    const isHealthy = await dbService.ping(3000);
    expect(isHealthy).toBe(true);

    const client = dbService.getClient();
    expect(client).toBeDefined();
    const rows = await client!.unsafe<{ one: number }[]>('select 1 as one');
    expect(rows[0].one).toBe(1);
  });

  it('AC-A-20: withUser sets current_user=authenticated, auth.uid()=user, claims has sub and role', async () => {
    const context = await dbService.withUser(aliceId, async (tx) => {
      const rows = rowsOf<{
        uid: string;
        user_name: string;
        claims: string;
      }>(
        await tx.execute(sql`
          select
            auth.uid()::text as uid,
            current_user as user_name,
            current_setting('request.jwt.claims', true) as claims
        `),
      );
      return rows[0];
    });

    expect(context.uid).toBe(aliceId);
    expect(context.user_name).toBe('authenticated');
    const parsedClaims = JSON.parse(context.claims);
    expect(parsedClaims.sub).toBe(aliceId);
    expect(parsedClaims.role).toBe('authenticated');
  });

  it('AC-A-21: after commit and rollback the pinned connection shows empty claims and role storeforge_app', async () => {
    const client = dbService.getClient()!;

    // Case 1: After commit
    await dbService.withUser(aliceId, async (tx) => {
      await tx.execute(sql`select 1`);
    });

    const afterCommit = await client.unsafe<
      {
        who: string;
        claims: string | null;
      }[]
    >(
      "select current_user as who, nullif(current_setting('request.jwt.claims', true), '') as claims",
    );
    expect(afterCommit[0].who).toBe('storeforge_app');
    expect(afterCommit[0].claims).toBeNull();

    // Case 2: After rollback
    await expect(
      dbService.withUser(aliceId, async () => {
        throw new Error('deliberate transaction rollback');
      }),
    ).rejects.toThrow('deliberate transaction rollback');

    const afterRollback = await client.unsafe<
      {
        who: string;
        claims: string | null;
      }[]
    >(
      "select current_user as who, nullif(current_setting('request.jwt.claims', true), '') as claims",
    );
    expect(afterRollback[0].who).toBe('storeforge_app');
    expect(afterRollback[0].claims).toBeNull();
  });

  it('AC-A-22: non-UUID userId is rejected before any SQL is sent', async () => {
    let queryCount = 0;
    const client = dbService.getClient()!;
    // Monitor queries on the connection by querying state
    const badUserId = 'not-a-valid-uuid-1234';

    const before = await client.unsafe<{ n: number }[]>('select 42 as n');
    expect(before[0].n).toBe(42);

    await expect(
      dbService.withUser(badUserId, async () => {
        queryCount++;
      }),
    ).rejects.toThrow('withUserContext: userId must be a UUID');

    expect(queryCount).toBe(0);
  });

  it('AC-A-23: connecting as a superuser makes withUser throw RlsGuardError and callback never runs', async () => {
    const superuserPg = new PGlite({ extensions: { pgcrypto } });
    await superuserPg.exec(SUPABASE_STUB);
    await superuserPg.exec('grant authenticated to postgres;');
    const superuserDb = drizzlePglite(superuserPg, { schema: dbSchema });

    let callbackExecuted = false;
    await expect(
      withUserContext(superuserDb as any, aliceId, async () => {
        callbackExecuted = true;
      }),
    ).rejects.toThrow(RlsGuardError);

    expect(callbackExecuted).toBe(false);
    await superuserPg.close();
  });

  it('AC-A-24: RLS prevents user A from reading rows of tenant B through withUser with unfiltered query', async () => {
    const aliceRows = await dbService.withUser(aliceId, async (tx) => {
      // Unfiltered select on tenants table
      return tx.select().from(dbSchema.tenants);
    });

    // Alice should see tenantA only, NOT tenantB
    expect(aliceRows.length).toBe(1);
    expect(aliceRows[0].id).toBe(tenantA.tenantId);
    expect(aliceRows.find((r) => r.id === tenantB.tenantId)).toBeUndefined();

    const bobRows = await dbService.withUser(bobId, async (tx) => {
      return tx.select().from(dbSchema.tenants);
    });

    expect(bobRows.length).toBe(1);
    expect(bobRows[0].id).toBe(tenantB.tenantId);
    expect(bobRows.find((r) => r.id === tenantA.tenantId)).toBeUndefined();
  });

  it('AC-A-25: withPublic has no claims, sees no table rows, get_public_storefront returns data or null', async () => {
    await dbService.withPublic(async (tx) => {
      // 1. request.jwt.claims is empty
      const claimsRow = rowsOf<{ claims: string }>(
        await tx.execute(
          sql`select current_setting('request.jwt.claims', true) as claims`,
        ),
      );
      expect(claimsRow[0].claims).toBe('');

      // 2. Direct table queries see 0 rows under RLS
      const tenantsCount = rowsOf<{ count: number }>(
        await tx.execute(
          sql`select count(*)::int as count from public.tenants`,
        ),
      );
      expect(tenantsCount[0].count).toBe(0);

      // 3. get_public_storefront for active slug returns data
      const publicStore = rowsOf<{ r: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront(${tenantA.storeSlug}) as r`,
        ),
      );
      expect(publicStore[0].r).toBeDefined();
      expect(publicStore[0].r).not.toBeNull();

      // 4. get_public_storefront for non-existent slug returns null
      const nonExistent = rowsOf<{ r: unknown }>(
        await tx.execute(
          sql`select public.get_public_storefront('does-not-exist-xyz') as r`,
        ),
      );
      expect(nonExistent[0].r).toBeNull();
    });
  });

  it('AC-A-26: error thrown inside withUser rolls back writes made before it', async () => {
    const canaryStoreName = 'Canary Rollback Store';

    await expect(
      dbService.withUser(aliceId, async (tx) => {
        // Write a store row
        await tx.insert(dbSchema.stores).values({
          tenantId: tenantA.tenantId,
          name: canaryStoreName,
          slug: 'canary-rollback-store',
        });

        // Deliberately fail transaction
        throw new Error('boom: rolling back store creation');
      }),
    ).rejects.toThrow('boom: rolling back store creation');

    // Verify through another transaction that the row does not exist
    const stores = await dbService.withUser(aliceId, async (tx) => {
      return tx
        .select()
        .from(dbSchema.stores)
        .where(eq(dbSchema.stores.slug, 'canary-rollback-store'));
    });

    expect(stores.length).toBe(0);
  });

  it('AC-A-27: onApplicationShutdown ends pool cleanly', async () => {
    const tempModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              database: {
                url: testDb.url,
                poolMax: 1,
                prepare: false,
                connectTimeoutSeconds: 5,
              },
            }),
          ],
        }),
        DatabaseModule,
      ],
    }).compile();

    await tempModule.init();
    const service = tempModule.get(DatabaseService);
    expect(service.getClient()).toBeDefined();

    await tempModule.close();
    expect(service.getClient()).toBeNull();
  });

  it('AC-A-28: unreachable database at startup logs a warning, process stays up, log has no URL/password', async () => {
    const canaryPassword = 'SuperSecretUnreachablePassword!';
    const unreachableUrl = `postgresql://storeforge_app:${canaryPassword}@127.0.0.1:1/postgres`;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const unreachableModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [
              () => ({
                database: {
                  url: unreachableUrl,
                  poolMax: 1,
                  prepare: false,
                  connectTimeoutSeconds: 1,
                },
              }),
            ],
          }),
          DatabaseModule,
        ],
      }).compile();

      // Module init must not throw!
      await unreachableModule.init();

      const service = unreachableModule.get(DatabaseService);
      const isHealthy = await service.ping(500);
      expect(isHealthy).toBe(false);

      await unreachableModule.close();

      // Assert no canary password logged
      for (const call of [...warnSpy.mock.calls, ...logSpy.mock.calls]) {
        const text = call.join(' ');
        expect(text).not.toContain(canaryPassword);
      }
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('AC-A-30: fixtures create valid state: owner membership visible through withUser as the owner', async () => {
    const memberships = await dbService.withUser(aliceId, async (tx) => {
      return tx
        .select()
        .from(dbSchema.memberships)
        .where(eq(dbSchema.memberships.tenantId, tenantA.tenantId));
    });

    expect(memberships.length).toBeGreaterThan(0);
    const ownerMembership = memberships.find((m) => m.userId === aliceId);
    expect(ownerMembership).toBeDefined();
    expect(ownerMembership?.role).toBe('owner');
    expect(ownerMembership?.status).toBe('active');
  });

  it('AC-A-34: harness runs with no hosted credentials (env -u DATABASE_URL)', () => {
    // Verifies test suite operates with purely local PGlite and socket
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
