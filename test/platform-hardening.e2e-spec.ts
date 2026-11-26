import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorChain } from '../src/common/db-errors.js';
import { rowsOf } from '../src/database/database.service.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import {
  asUser,
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Statement = ReturnType<typeof sql>;

/**
 * The platform role matrix, checked AT THE DATABASE: these calls skip the API entirely and run the SQL a role could run if an API route
 * ever forgot its permission. Roles: super (super_admin), op (admin = Platform Admin), bill (billing_admin), sup (support_admin).
 */
describe.skipIf(!migrationsAvailable)(
  'platform role enforcement in the database (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let sup: Client;
    let alice: Client;
    let aliceH: Client;
    let bobH: Client; // owner of tenant B, which is on the unrestricted plan (no feature or limit gets in the way)
    let ids: { super: string; op: string; bill: string; sup: string };
    let paidId: string;

    /** Runs `statement` as `user`; returns the error text (the SQL function's RAISE code) or null when it succeeded. */
    const attempt = async (
      user: string,
      statement: Statement,
    ): Promise<string | null> => {
      try {
        await asUser(t.db, user, (tx) => tx.execute(statement));
        return null;
      } catch (e) {
        return errorChain(e);
      }
    };
    const count = async (user: string, table: string) =>
      asUser(
        t.db,
        user,
        async (tx) =>
          rowsOf<{ n: number }>(
            await tx.execute(
              sql.raw(`select count(*)::int as n from public.${table}`),
            ),
          )[0].n,
      );

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      ids = {
        super: w.superAdmin,
        op: w.admin,
        bill: await createPlatformAdmin(
          db,
          'billing@example.test',
          'billing_admin',
        ),
        sup: await createPlatformAdmin(
          db,
          'support@example.test',
          'support_admin',
        ),
      };
      t = await createTestApp(db);
      sup = await as(t, w.superAdmin);
      alice = await as(t, w.alice);
      aliceH = await as(t, w.alice, w.tenantA);
      bobH = await as(t, w.bob, w.tenantB);
      paidId = (
        await sup
          .post('/platform/plans', {
            code: 'paid',
            name: 'Paid',
            monthlyPrice: '100',
            yearlyPrice: '1000',
          })
          .expect(201)
      ).body.data.id;
      await sup
        .put(`/platform/organizations/${w.tenantA}/subscription`, {
          planId: paidId,
        })
        .expect(200);
    });

    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('operator functions (tenants, stores, team, plans, subscriptions)', () => {
      it('refuse Billing and Support admins, and accept the operator roles', async () => {
        const calls: [string, (u: string) => Statement][] = [
          [
            'platform_set_tenant_status',
            () =>
              sql`select public.platform_set_tenant_status(${w.tenantB}::uuid, 'active')`,
          ],
          [
            'platform_update_tenant',
            () =>
              sql`select public.platform_update_tenant(${w.tenantB}::uuid, 'Beta Co', null, null)`,
          ],
          [
            'platform_assign_plan',
            () =>
              sql`select public.platform_assign_plan(${w.tenantB}::uuid, ${paidId}::uuid, 'monthly', false)`,
          ],
          [
            'platform_list_admins',
            () => sql`select * from public.platform_list_admins()`,
          ],
          [
            'platform_audit_admins',
            () => sql`select * from public.platform_audit_admins()`,
          ],
          [
            'platform_delete_tenant',
            () =>
              sql`select public.platform_delete_tenant('00000000-0000-4000-8000-000000000009'::uuid)`,
          ],
        ];
        for (const [name, call] of calls) {
          for (const denied of [ids.bill, ids.sup])
            expect(
              await attempt(denied, call(denied)),
              `${name} as ${denied}`,
            ).toContain('not_platform_admin');
          // The operator roles pass the role check (they may still get a business error such as not_found).
          for (const ok of [ids.super, ids.op])
            expect(
              (await attempt(ok, call(ok))) ?? '',
              `${name} as ${ok}`,
            ).not.toContain('not_platform_admin');
        }
      });

      it('refuse a tenant Owner and a person with no organization', async () => {
        for (const user of [w.alice, w.carol])
          expect(
            await attempt(
              user,
              sql`select public.platform_set_tenant_status(${w.tenantB}::uuid, 'suspended')`,
            ),
          ).toContain('not_platform_admin');
      });
    });

    describe('billing functions (invoices, payments, refunds, runs)', () => {
      it('refuse the Platform Admin and Support, and accept Billing and the super admin', async () => {
        for (const denied of [ids.op, ids.sup]) {
          expect(
            await attempt(
              denied,
              sql`select public.platform_issue_invoice(${w.tenantA}::uuid, 'current')`,
            ),
          ).toContain('not_platform_admin');
          expect(
            await attempt(denied, sql`select public.platform_run_billing()`),
          ).toContain('not_platform_admin');
          expect(
            await attempt(
              denied,
              sql`select public.platform_void_invoice('00000000-0000-4000-8000-000000000009'::uuid, 'a reason')`,
            ),
          ).toContain('not_platform_admin');
          expect(
            await attempt(
              denied,
              sql`select public.platform_refund_begin('00000000-0000-4000-8000-000000000009'::uuid, 100::bigint, 'a reason', 'key-1234567')`,
            ),
          ).toContain('not_platform_admin');
          expect(
            await attempt(
              denied,
              sql`select public.platform_record_manual_payment('00000000-0000-4000-8000-000000000009'::uuid, 'ref 1', 'bank', null)`,
            ),
          ).toContain('not_platform_admin');
        }
        expect(
          await attempt(ids.bill, sql`select public.platform_run_billing()`),
        ).toBeNull();
        expect(
          await attempt(ids.super, sql`select public.platform_run_billing()`),
        ).toBeNull();
        // A Billing Admin gets as far as the business rules.
        expect(
          await attempt(
            ids.bill,
            sql`select public.platform_void_invoice('00000000-0000-4000-8000-000000000009'::uuid, 'a reason')`,
          ),
        ).toContain('not_found');
      });

      it('lets a Billing Admin issue an invoice, and keeps Billing away from tenant operations', async () => {
        const issued = await attempt(
          ids.bill,
          sql`select public.platform_issue_invoice(${w.tenantA}::uuid, 'current')`,
        );
        expect(issued).toBeNull();
        expect(await count(ids.bill, 'billing_invoices')).toBe(1);
        expect(
          await attempt(
            ids.bill,
            sql`select public.platform_assign_plan(${w.tenantA}::uuid, ${paidId}::uuid, 'monthly', false)`,
          ),
        ).toContain('not_platform_admin');
      });
    });

    describe('tables', () => {
      it('lets every staff role read plans and a tenant subscription, but only operators change plans', async () => {
        for (const u of Object.values(ids))
          expect(await count(u, 'plans')).toBeGreaterThan(0);
        for (const u of Object.values(ids))
          expect(await count(u, 'tenant_subscriptions')).toBeGreaterThan(0);
        const insert = sql`insert into public.plans (code, name) values ('sneaky', 'Sneaky')`;
        expect(await attempt(ids.bill, insert)).not.toBeNull();
        expect(await attempt(ids.sup, insert)).not.toBeNull();
        expect(await attempt(ids.op, insert)).toBeNull();
        const before = await count(ids.super, 'plans');
        await asUser(t.db, ids.sup, (tx) =>
          tx.execute(sql`update public.plans set name = 'Hijacked'`),
        );
        await asUser(t.db, ids.bill, (tx) =>
          tx.execute(sql`delete from public.plan_features`),
        );
        expect(await count(ids.super, 'plans')).toBe(before);
        const names = await asUser(t.db, ids.super, async (tx) =>
          rowsOf<{ name: string }>(
            await tx.execute(sql`select name from public.plans`),
          ),
        );
        expect(names.some((n) => n.name === 'Hijacked')).toBe(false);
      });

      it('lets only operators change entitlement exceptions', async () => {
        const insert = sql`insert into public.tenant_feature_overrides (tenant_id, feature_key, enabled) values (${w.tenantB}::uuid, 'discount_codes', true)`;
        expect(await attempt(ids.bill, insert)).not.toBeNull();
        expect(await attempt(ids.sup, insert)).not.toBeNull();
        expect(await attempt(ids.op, insert)).toBeNull();
        expect(await count(ids.sup, 'tenant_feature_overrides')).toBe(1); // reading is open to all staff
      });

      it('shows invoices, payments and webhook events to the billing-related roles only', async () => {
        for (const u of [ids.super, ids.op, ids.bill])
          expect(await count(u, 'billing_invoices')).toBe(1);
        expect(await count(ids.sup, 'billing_invoices')).toBe(0);
        await t.db.asOwner((pg) =>
          pg.query(
            "insert into billing_webhook_events (event_id, event_type) values ('evt_h1', 'payment.captured')",
          ),
        );
        expect(await count(ids.bill, 'billing_webhook_events')).toBe(1);
        expect(await count(ids.sup, 'billing_webhook_events')).toBe(0);
      });

      it('lets only billing roles change billing settings, and nobody else even by a direct update', async () => {
        const read = (u: string) =>
          asUser(
            t.db,
            u,
            async (tx) =>
              rowsOf<{ tax: number }>(
                await tx.execute(
                  sql`select tax_rate_bps as tax from public.billing_settings`,
                ),
              )[0]?.tax,
          );
        const update = (u: string, bps: number) =>
          asUser(
            t.db,
            u,
            async (tx) =>
              rowsOf<{ id: boolean }>(
                await tx.execute(
                  sql`update public.billing_settings set tax_rate_bps = ${bps} returning id`,
                ),
              ).length,
          );
        expect(await update(ids.op, 500)).toBe(0); // refused: no row is changed
        expect(await update(ids.sup, 500)).toBe(0);
        expect(await read(ids.sup)).toBeUndefined(); // Support cannot even read them
        expect(await update(ids.bill, 1800)).toBe(1);
        expect(await read(ids.op)).toBe(1800);
        expect(await update(ids.super, 0)).toBe(1);
      });

      it('shows monitoring records to operators only', async () => {
        await t.db.asOwner((pg) =>
          pg.query(
            "insert into platform_error_events (method, route, status, error_name, message) values ('GET', '/x', 500, 'Error', 'm')",
          ),
        );
        expect(await count(ids.op, 'platform_error_events')).toBe(1);
        expect(await count(ids.super, 'platform_job_runs')).toBe(0);
        for (const u of [ids.bill, ids.sup, w.alice])
          expect(await count(u, 'platform_error_events')).toBe(0);
      });

      it('still lets Support see one organization subscription and its plan name through the API', async () => {
        const support = await as(t, ids.sup);
        const s = (
          await support
            .get(`/platform/organizations/${w.tenantA}/subscription`)
            .expect(200)
        ).body.data;
        expect(s.plan.name).toBe('Paid');
        await support
          .get(`/platform/organizations/${w.tenantA}/entitlements`)
          .expect(200);
        await support
          .get(`/platform/organizations/${w.tenantA}/activity`)
          .expect(200);
      });
    });

    describe('platform roles cannot be reached through tenant APIs', () => {
      it('refuses any attempt to put a platform role or permission in a team request', async () => {
        // Tenant B was moved to the paid plan by an earlier test; put it back on the unrestricted plan so the request reaches validation.
        const legacy = (
          await sup.get('/platform/plans').expect(200)
        ).body.data.find((p: { code: string }) => p.code === 'legacy').id;
        await sup
          .put(`/platform/organizations/${w.tenantB}/subscription`, {
            planId: legacy,
          })
          .expect(200);
        const base = {
          fullName: 'Sneaky Staff',
          email: 'sneaky@example.test',
          password: 'Passw0rd-1',
          permissions: { products: 'read' },
        };
        for (const extra of [
          { role: 'super_admin' },
          { platformRole: 'super_admin' },
          { level: 'super_admin' },
          { isPlatformAdmin: true },
        ]) {
          const res = await bobH.post('/team/members', { ...base, ...extra });
          expect(res.status, JSON.stringify(extra)).toBe(400);
        }
        await aliceH
          .patch(`/team/members/${w.members.reader}`, { role: 'super_admin' })
          .expect(400);
        expect(
          (
            await t.db.asOwner((pg) =>
              pg.query(
                "select count(*)::int as n from platform_admins where role <> 'admin' and user_id not in ($1,$2,$3)",
                [ids.super, ids.bill, ids.sup],
              ),
            )
          ).rows[0],
        ).toEqual({ n: 0 });
      });

      it('cannot make a tenant user a platform admin, directly or through the admin function', async () => {
        expect(
          await attempt(
            w.alice,
            sql`insert into public.platform_admins (user_id, role) values (${w.alice}::uuid, 'super_admin')`,
          ),
        ).not.toBeNull();
        expect(
          await attempt(
            w.alice,
            sql`select public.platform_add_admin(${w.carol}::uuid, 'super_admin')`,
          ),
        ).toContain('not_super_admin');
        for (const u of [ids.op, ids.bill, ids.sup])
          expect(
            await attempt(
              u,
              sql`select public.platform_add_admin(${w.carol}::uuid, 'super_admin')`,
            ),
            u,
          ).toContain('not_super_admin');
        expect(
          await attempt(
            ids.op,
            sql`select public.platform_set_admin_role(${ids.sup}::uuid, 'super_admin')`,
          ),
        ).toContain('not_super_admin');
        await aliceH
          .post('/platform/admins', {
            fullName: 'X Y',
            email: 'x@example.test',
            password: 'Passw0rd-1',
            role: 'super_admin',
          })
          .expect(403);
      });

      it('cannot make a platform admin a member of an organization, even as the database owner', async () => {
        await expect(
          t.db.asOwner((pg) =>
            pg.query(
              "insert into memberships (tenant_id, user_id, role) values ($1, $2, 'admin')",
              [w.tenantA, ids.op],
            ),
          ),
        ).rejects.toThrow();
        await expect(
          t.db.asOwner((pg) =>
            pg.query(
              "insert into platform_admins (user_id, role) values ($1, 'admin')",
              [w.alice],
            ),
          ),
        ).rejects.toThrow();
      });
    });

    describe('usage limits cannot be bypassed', () => {
      it('refuses a bulk import that would pass the product limit, and imports nothing', async () => {
        const limited = (
          await sup
            .post('/platform/plans', {
              code: 'tiny',
              name: 'Tiny',
              monthlyPrice: '0',
              yearlyPrice: '0',
              limits: { products: { hard: 3 } },
            })
            .expect(201)
        ).body.data.id;
        await sup
          .put(`/platform/organizations/${w.tenantA}/subscription`, {
            planId: limited,
          })
          .expect(200);
        const total = async () =>
          (await alice.get('/products?limit=1').expect(200)).body.meta
            .total as number;
        const before = await total();
        const rows = (n: number) =>
          Array.from({ length: n }, (_, i) => ({
            row: i + 2,
            name: `Bulk ${n}-${i}`,
            price: '10.00',
          }));

        const over = await alice
          .post('/products/import', { rows: rows(4) })
          .expect(403);
        expect(over.body.error).toMatchObject({
          code: 'PLAN_LIMIT_REACHED',
          details: { limit: 'products', hard: 3 },
        });
        expect(await total()).toBe(before);

        await alice.post('/products/import', { rows: rows(3) }).expect(201);
        expect(await total()).toBe(before + 3);
        const again = await alice
          .post('/products/import', { rows: rows(1) })
          .expect(403);
        expect(again.body.error.code).toBe('PLAN_LIMIT_REACHED');
      });
    });
  },
);
