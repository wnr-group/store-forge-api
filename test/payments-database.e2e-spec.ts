import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { isValidKeyId } from '../src/modules/payments/key-id.js';
import { KEY_ID_CORPUS } from './support/key-id-corpus.js';
import { SUPABASE_STUB } from './support/database/supabase-stub.js';
import {
  asUser,
  migrationsAvailable,
  MIGRATIONS_DIR,
} from './support/pglite.js';
import { keyId, outcome, TABLE, usePaymentsDb } from './support/payments-db.js';

describe.skipIf(!migrationsAvailable)(
  'tenant_razorpay_config migrations and constraints [PG] (e2e)',
  () => {
    const { t, w, own, rowOf, seedRow, clear, evidence } = usePaymentsDb();

    describe('migrations and constraints', () => {
      it('AC-DB-01: migration 0042 applies to an empty database and creates the table', async () => {
        const journal = JSON.parse(
          readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
        ) as { entries: { tag: string }[] };
        const tags = journal.entries.map((e) => e.tag);
        const exists = await own((pg) =>
          pg.query<{ r: string | null }>(
            `select to_regclass('${TABLE}')::text as r`,
          ),
        );
        await evidence(
          'AC-DB-01',
          'all migrations applied to an empty PGlite database; the table exists',
          {
            tableRegclass: exists.rows[0].r,
            journalHasMigration: tags.includes('0042_tenant_razorpay_config'),
          },
          () => {
            expect(tags).toContain('0042_tenant_razorpay_config');
            expect(exists.rows[0].r).toBe('tenant_razorpay_config');
          },
        );
      });

      it('AC-DB-02 and AC-DB-07: re-running the migrator is a no-op and the applied count equals the journal', async () => {
        await own(() =>
          migrate(drizzle(t.pg), { migrationsFolder: MIGRATIONS_DIR }),
        );
        const journal = JSON.parse(
          readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
        ) as { entries: unknown[] };
        const applied = await own((pg) =>
          pg.query<{ n: number }>(
            'select count(*)::int as n from drizzle.__drizzle_migrations',
          ),
        );
        const flag = await own((pg) =>
          pg.query(`select data_type, is_nullable, column_default from information_schema.columns
                  where table_schema='public' and table_name='tenants' and column_name='customer_auth_enabled'`),
        );
        await evidence(
          'AC-DB-02',
          'second migrate() run applied nothing; history rows equal journal entries',
          {
            applied: applied.rows[0].n,
            journalEntries: journal.entries.length,
          },
          () => {
            expect(applied.rows[0].n).toBe(journal.entries.length);
          },
        );
        await evidence(
          'AC-DB-07',
          '0043 applied and idempotent: boolean NOT NULL DEFAULT false',
          { column: flag.rows[0] },
          () => {
            expect(flag.rows[0]).toMatchObject({
              data_type: 'boolean',
              is_nullable: 'NO',
              column_default: 'false',
            });
          },
        );
      });

      it('AC-DB-03: primary key tenant_id, cascading foreign key to tenants, one row per tenant', async () => {
        const cons = await own((pg) =>
          pg.query<{ contype: string; def: string }>(
            `select contype::text, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = '${TABLE}'::regclass and contype in ('p','f')`,
          ),
        );
        await seedRow(w.tenantA, w.alice);
        const second = await outcome(
          own((pg) =>
            pg.query(
              `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version) values ($1,$2,'QUJD','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==',1)`,
              [w.tenantA, keyId()],
            ),
          ),
        );
        await clear();
        await evidence(
          'AC-DB-03',
          'PK(tenant_id), FK tenants ON DELETE CASCADE, duplicate tenant row rejected (23505)',
          { constraints: cons.rows, duplicateInsert: second },
          () => {
            expect(cons.rows.find((c) => c.contype === 'p')?.def).toBe(
              'PRIMARY KEY (tenant_id)',
            );
            expect(cons.rows.find((c) => c.contype === 'f')?.def).toMatch(
              /REFERENCES tenants\(id\) ON DELETE CASCADE/,
            );
            expect(second).toBe('23505');
          },
        );
      });

      it('AC-DB-04: CHECK constraints reject a bad key_id, iv, auth_tag and key_version', async () => {
        const base = {
          id: keyId(),
          ct: 'QUJD',
          iv: 'AAAAAAAAAAAAAAAA',
          tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
          ver: 1,
        };
        const tryInsert = (o: Partial<typeof base>) => {
          const v = { ...base, ...o };
          return outcome(
            own((pg) =>
              pg.query(
                `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version) values ($1,$2,$3,$4,$5,$6)`,
                [w.tenantB, v.id, v.ct, v.iv, v.tag, v.ver],
              ),
            ),
          );
        };
        const results = {
          badKeyId: await tryInsert({ id: 'rzp_test_short' }),
          badIv: await tryInsert({ iv: 'short' }),
          badTag: await tryInsert({ tag: 'AAAAAAAAAAAAAAAAAAAAAA' }),
          badVersion: await tryInsert({ ver: 0 }),
          badCiphertext: await tryInsert({ ct: 'not base64 !' }),
        };
        await clear();
        await evidence(
          'AC-DB-04',
          'each malformed value was rejected with a check violation (23514)',
          results,
          () => {
            for (const code of Object.values(results))
              expect(code).toBe('23514');
          },
        );
      });

      it('AC-DB-05: ciphertext cap is 2048 characters; 2049 is rejected and nothing is truncated', async () => {
        const at = (n: number) => 'A'.repeat(n - 4) + 'QUJD';
        const ins = (ct: string) =>
          outcome(
            own((pg) =>
              pg.query(
                `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version) values ($1,$2,$3,'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==',1)`,
                [w.tenantB, keyId(), ct],
              ),
            ),
          );
        const ok = await ins(at(2048));
        const stored = await rowOf(w.tenantB);
        await clear();
        const over = await ins(at(2049));
        await evidence(
          'AC-DB-05',
          '2048 characters accepted and stored whole; 2049 rejected',
          {
            at2048: ok,
            storedLength: String(stored?.secret_ciphertext).length,
            at2049: over,
          },
          () => {
            expect(ok).toBe('ok');
            expect(String(stored?.secret_ciphertext)).toHaveLength(2048);
            expect(over).toBe('23514');
          },
        );
      });

      it('AC-DB-06: the database Key ID check and the API Key ID pattern accept and reject the same corpus', async () => {
        // The same list the unit spec checks the API pattern against (src/modules/payments/key-id-corpus.spec.ts).
        const corpus = KEY_ID_CORPUS.map(([value]) => value);
        const disagreements: string[] = [];
        for (const [candidate, expected] of KEY_ID_CORPUS) {
          const db = await outcome(
            own((pg) =>
              pg.query(
                `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version) values ($1,$2,'QUJD','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==',1)`,
                [w.tenantB, candidate],
              ),
            ),
          );
          await clear();
          if (
            (db === 'ok') !== expected ||
            isValidKeyId(candidate) !== expected
          )
            disagreements.push(JSON.stringify(candidate));
        }
        await evidence(
          'AC-DB-06',
          `database and API pattern agreed on all ${corpus.length} corpus entries`,
          { corpusSize: corpus.length, disagreements },
          () => {
            expect(disagreements).toEqual([]);
          },
        );
      });

      it('AC-DB-08: tenants that existed before 0043 receive customer_auth_enabled = false', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mig-to-0042-'));
        try {
          cpSync(resolve(MIGRATIONS_DIR), dir, { recursive: true });
          const jp = join(dir, 'meta/_journal.json');
          const journal = JSON.parse(readFileSync(jp, 'utf8')) as {
            entries: { tag: string }[];
          };
          journal.entries = journal.entries.filter(
            (e) => e.tag <= '0042_tenant_razorpay_config',
          );
          writeFileSync(jp, JSON.stringify(journal));
          const pg = new PGlite({ extensions: { pgcrypto } });
          await pg.exec(SUPABASE_STUB);
          await migrate(drizzle(pg), { migrationsFolder: dir });
          await pg.query(
            "insert into tenants (name, slug, public_id) values ('Old One','old-one','aaaaa1'),('Old Two','old-two','aaaaa2')",
          );
          await migrate(drizzle(pg), {
            migrationsFolder: resolve(MIGRATIONS_DIR),
          });
          const flags = await pg.query<{
            slug: string;
            customer_auth_enabled: boolean;
          }>('select slug, customer_auth_enabled from tenants order by slug');
          await pg.close();
          await evidence(
            'AC-DB-08',
            'database built to 0042, two tenants inserted, then migrated to 0043: both false',
            { flags: flags.rows },
            () => {
              expect(flags.rows).toHaveLength(2);
              expect(
                flags.rows.every((r) => r.customer_auth_enabled === false),
              ).toBe(true);
            },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('AC-DB-09: 0043 adds no grant change; tenants grants stay table-level SELECT/DELETE and UPDATE (name, slug) [PG half]', async () => {
        const upd = await own((pg) =>
          pg.query<{ column_name: string }>(
            `select column_name from information_schema.column_privileges where table_schema='public' and table_name='tenants' and grantee='authenticated' and privilege_type='UPDATE' order by 1`,
          ),
        );
        await evidence(
          'AC-DB-09',
          'authenticated may UPDATE only name and slug on tenants; the new column has no UPDATE grant',
          { updatable: upd.rows.map((r) => r.column_name) },
          () => {
            expect(upd.rows.map((r) => r.column_name)).toEqual([
              'name',
              'slug',
            ]);
          },
        );
      });

      it('AC-DB-10: an Owner cannot update customer_auth_enabled [PG half]', async () => {
        const result = await outcome(
          asUser(t, w.alice, (tx) =>
            tx.execute(
              sql`update public.tenants set customer_auth_enabled = true where id = ${w.tenantA}::uuid`,
            ),
          ),
        );
        const flag = await own((pg) =>
          pg.query<{ v: boolean }>(
            'select customer_auth_enabled as v from tenants where id = $1',
            [w.tenantA],
          ),
        );
        await evidence(
          'AC-DB-10',
          'UPDATE of the flag as the tenant Owner failed with permission denied; the value is still false',
          { sqlstate: result, flag: flag.rows[0].v },
          () => {
            expect(result).toBe('42501');
            expect(flag.rows[0].v).toBe(false);
          },
        );
      });

      it('AC-DB-12 [layer:STATIC]: 0043 does not reference the payments table', () => {
        const file = readFileSync(
          join(MIGRATIONS_DIR, '0043_tenant_customer_auth_flag.sql'),
          'utf8',
        );
        expect(file).not.toMatch(/tenant_razorpay_config/i);
        expect(file).toMatch(/customer_auth_enabled/);
      });
    });
  },
);
