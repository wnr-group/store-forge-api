import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import {
  asUser,
  createTestDb,
  migrationsAvailable,
  type TestDb,
} from './support/pglite.js';
import { outcome } from './support/payments-db.js';
import { seedWorld, type World } from './support/world.js';

describe.skipIf(!migrationsAvailable)(
  'marketing & analytics schema: tenant isolation, constraints and grants (migration 0053)',
  () => {
    let t: TestDb;
    let w: World;
    const NEXT = (n: number) => `ST${n}`;
    let seq = 0;

    const addCode = (
      userId: string,
      tenantId: string,
      code = NEXT(++seq),
      extra = '',
    ) =>
      asUser(
        t,
        userId,
        async (tx) =>
          await tx.execute(
            sql.raw(`
          insert into discount_codes (tenant_id, code, kind, value, created_by, updated_by ${extra ? ', ' + extra.split('=')[0] : ''})
          values ('${tenantId}', '${code}', 'percentage', 1000, '${userId}', '${userId}' ${extra ? ', ' + extra.split('=')[1] : ''})`),
          ),
      );
    const addIntegration = (
      userId: string,
      tenantId: string,
      provider = 'ga4',
    ) =>
      asUser(
        t,
        userId,
        async (tx) =>
          await tx.execute(sql`
          insert into marketing_integrations (tenant_id, provider_code, config, created_by, updated_by)
          values (${tenantId}::uuid, ${provider}, '{"measurementId":"G-ABCDEFGH12"}'::jsonb, ${userId}::uuid, ${userId}::uuid)`),
      );

    beforeAll(async () => {
      t = await createTestDb();
      w = await seedWorld(t);
    });
    afterAll(() => t.close());

    describe('discount codes', () => {
      it('an Owner creates a code and reads it back; the other tenant sees nothing', async () => {
        await addCode(w.alice, w.tenantA, 'WELCOME10');
        const mine = await asUser(t, w.alice, async (tx) =>
          rowsOf<{ code: string }>(
            await tx.execute(sql`select code from discount_codes`),
          ),
        );
        expect(mine.map((r) => r.code)).toEqual(['WELCOME10']);
        const theirs = await asUser(t, w.bob, async (tx) =>
          rowsOf(await tx.execute(sql`select 1 from discount_codes`)),
        );
        expect(theirs).toEqual([]);
      });

      it('rejects a duplicate code inside a tenant but allows it in another', async () => {
        await expect(
          addCode(w.alice, w.tenantA, 'WELCOME10'),
        ).rejects.toThrow();
        await expect(
          addCode(w.bob, w.tenantB, 'WELCOME10'),
        ).resolves.toBeDefined();
      });

      it('rejects codes that are not stored upper-case and values out of range', async () => {
        await expect(addCode(w.alice, w.tenantA, 'lower')).rejects.toThrow();
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into discount_codes (tenant_id, code, kind, value, created_by, updated_by)
              values (${w.tenantA}::uuid, 'TOOMUCH', 'percentage', 10001, ${w.alice}::uuid, ${w.alice}::uuid)`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into discount_codes (tenant_id, code, kind, value, max_discount_minor, created_by, updated_by)
              values (${w.tenantA}::uuid, 'FIXEDCAP', 'fixed', 500, 100, ${w.alice}::uuid, ${w.alice}::uuid)`),
          ),
        ).rejects.toThrow();
      });

      it('a read-only member cannot create or change a code; a member with no orders access cannot even read them', async () => {
        await expect(addCode(w.members.reader, w.tenantA)).rejects.toThrow();
        const none = await asUser(t, w.members.nothing, async (tx) =>
          rowsOf(await tx.execute(sql`select 1 from discount_codes`)),
        );
        expect(none).toEqual([]);
        const changed = await asUser(t, w.members.reader, async (tx) =>
          rowsOf(
            await tx.execute(
              sql`update discount_codes set is_active = false, updated_by = ${w.members.reader}::uuid returning 1`,
            ),
          ),
        );
        expect(changed).toEqual([]);
      });

      it('the dashboard can never edit the redemption counter', async () => {
        expect(
          await outcome(
            asUser(t, w.alice, async (tx) => {
              await tx.execute(
                sql`update discount_codes set redemption_count = 99`,
              );
            }),
          ),
        ).toBe('42501');
      });

      it("a campaign target cannot point at another tenant's product", async () => {
        const productB = await t.asOwner(async (pg) => {
          const r = await pg.query<{ id: string }>(
            `insert into products (tenant_id, name, slug, price_minor) values ($1, 'Beta thing', 'beta-thing', 1000) returning id`,
            [w.tenantB],
          );
          return r.rows[0].id;
        });
        const campaignId = await asUser(t, w.alice, async (tx) =>
          rowsOf<{ id: string }>(
            await tx.execute(sql`insert into promotional_campaigns (tenant_id, name, created_by, updated_by)
              values (${w.tenantA}::uuid, 'Diwali', ${w.alice}::uuid, ${w.alice}::uuid) returning id`),
          ),
        );
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into campaign_targets (tenant_id, campaign_id, product_id)
              values (${w.tenantA}::uuid, ${campaignId[0].id}::uuid, ${productB}::uuid)`),
          ),
        ).rejects.toThrow();
      });

      it('campaign names are unique per tenant regardless of case, and the end must follow the start', async () => {
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into promotional_campaigns (tenant_id, name, created_by, updated_by)
              values (${w.tenantA}::uuid, 'DIWALI', ${w.alice}::uuid, ${w.alice}::uuid)`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into promotional_campaigns (tenant_id, name, starts_at, ends_at, created_by, updated_by)
              values (${w.tenantA}::uuid, 'Backwards', now(), now() - interval '1 day', ${w.alice}::uuid, ${w.alice}::uuid)`),
          ),
        ).rejects.toThrow();
      });
    });

    describe('marketing integrations', () => {
      it('stores a connection for the tenant and hides it from the other tenant', async () => {
        await addIntegration(w.alice, w.tenantA);
        const other = await asUser(t, w.bob, async (tx) =>
          rowsOf(await tx.execute(sql`select 1 from marketing_integrations`)),
        );
        expect(other).toEqual([]);
      });

      it('cannot be enabled until it is validated, and validating allows it', async () => {
        const call = (fn: string, args: string) =>
          asUser(
            t,
            w.alice,
            async (tx) =>
              rowsOf<{ r: string }>(
                await tx.execute(
                  sql.raw(
                    `select public.${fn}('${w.tenantA}'::uuid, 'ga4', ${args}) as r`,
                  ),
                ),
              )[0].r,
          );
        expect(await call('set_marketing_integration_enabled', 'true')).toBe(
          'not_valid',
        );
        expect(
          await call('record_marketing_integration_validation', 'true, null'),
        ).toBe('ok');
        expect(await call('set_marketing_integration_enabled', 'true')).toBe(
          'ok',
        );
        const row = await asUser(t, w.alice, async (tx) =>
          rowsOf<{ enabled: boolean; validation_status: string }>(
            await tx.execute(
              sql`select enabled, validation_status from marketing_integrations where provider_code = 'ga4'`,
            ),
          ),
        );
        expect(row[0]).toEqual({ enabled: true, validation_status: 'valid' });
      });

      it('changing the identifier switches the integration off until it is validated again', async () => {
        await asUser(
          t,
          w.alice,
          async (tx) =>
            await tx.execute(sql`update marketing_integrations
            set config = '{"measurementId":"G-ZZZZZZZZZZ"}'::jsonb, updated_by = ${w.alice}::uuid
            where provider_code = 'ga4'`),
        );
        const row = await asUser(t, w.alice, async (tx) =>
          rowsOf<{ enabled: boolean; validation_status: string }>(
            await tx.execute(
              sql`select enabled, validation_status from marketing_integrations where provider_code = 'ga4'`,
            ),
          ),
        );
        expect(row[0]).toEqual({
          enabled: false,
          validation_status: 'unverified',
        });
      });

      it('refuses to enable by a plain update, so the check cannot be skipped', async () => {
        expect(
          await outcome(
            asUser(t, w.alice, async (tx) => {
              await tx.execute(
                sql`update marketing_integrations set enabled = true where provider_code = 'ga4'`,
              );
            }),
          ),
        ).toBe('42501');
      });

      it('a member with read-only settings access cannot change or enable it; another tenant cannot either', async () => {
        const outcome = await asUser(t, w.members.reader, async (tx) =>
          rowsOf<{ r: string }>(
            await tx.execute(
              sql`select public.set_marketing_integration_enabled(${w.tenantA}::uuid, 'ga4', false) as r`,
            ),
          ),
        );
        expect(outcome[0].r).toBe('forbidden');
        const cross = await asUser(t, w.bob, async (tx) =>
          rowsOf<{ r: string }>(
            await tx.execute(
              sql`select public.set_marketing_integration_enabled(${w.tenantA}::uuid, 'ga4', false) as r`,
            ),
          ),
        );
        expect(cross[0].r).toBe('forbidden');
        await expect(
          addIntegration(w.members.reader, w.tenantA, 'meta_pixel'),
        ).rejects.toThrow();
      });

      it('the request role can never read the secret columns', async () => {
        expect(
          await outcome(
            asUser(t, w.alice, async (tx) => {
              await tx.execute(
                sql`select secret_ciphertext from marketing_integrations`,
              );
            }),
          ),
        ).toBe('42501');
      });

      it('a secret must be complete or absent', async () => {
        await expect(
          asUser(
            t,
            w.alice,
            async (tx) =>
              await tx.execute(sql`insert into marketing_integrations (tenant_id, provider_code, secret_ciphertext, created_by, updated_by)
              values (${w.tenantA}::uuid, 'meta_pixel', 'AAAA', ${w.alice}::uuid, ${w.alice}::uuid)`),
          ),
        ).rejects.toThrow();
      });
    });

    describe('abandoned carts', () => {
      it('the dashboard can read carts but never the lookup hashes', async () => {
        await t.asOwner((pg) =>
          pg.query(
            `insert into abandoned_carts (tenant_id, cart_key_hash, recovery_token_hash, email, items, item_count, cart_value_minor, currency)
             values ($1, 'k1', 'r1', 'a@example.test', '[{"productId":"x"}]'::jsonb, 1, 500, 'INR')`,
            [w.tenantA],
          ),
        );
        const mine = await asUser(t, w.alice, async (tx) =>
          rowsOf<{ email: string }>(
            await tx.execute(sql`select email from abandoned_carts`),
          ),
        );
        expect(mine).toEqual([{ email: 'a@example.test' }]);
        expect(
          await outcome(
            asUser(t, w.alice, async (tx) => {
              await tx.execute(
                sql`select recovery_token_hash from abandoned_carts`,
              );
            }),
          ),
        ).toBe('42501');
        const other = await asUser(t, w.bob, async (tx) =>
          rowsOf(await tx.execute(sql`select 1 from abandoned_carts`)),
        );
        expect(other).toEqual([]);
      });

      it('the dashboard cannot insert or change carts', async () => {
        expect(
          await outcome(
            asUser(t, w.alice, async (tx) => {
              await tx.execute(
                sql`update abandoned_carts set status = 'recovered'`,
              );
            }),
          ),
        ).toBe('42501');
      });
    });
  },
);
