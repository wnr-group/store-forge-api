import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import { encryptSecret } from '../src/modules/payments/credentials-crypto.js';
import {
  asUser,
  createUser,
  migrationsAvailable,
  provision,
} from './support/pglite.js';
import {
  KEY_ENV,
  keyId,
  outcome,
  SECRET_COLUMNS,
  sqlstate,
  SYNTH_SECRET,
  TABLE,
  usePaymentsDb,
} from './support/payments-db.js';

describe.skipIf(!migrationsAvailable)(
  'tenant_razorpay_config column privileges and RLS [PG] (e2e)',
  () => {
    const {
      t,
      w,
      x,
      own,
      rowOf,
      seedRow,
      clear,
      upsertAs,
      selectAs,
      asDbRole,
      evidence,
    } = usePaymentsDb();

    describe('column privileges and RLS', () => {
      it('AC-RLS-01: storeforge_app holds no privilege on the table without SET ROLE', async () => {
        const read = await outcome(
          t.pg.query(`select tenant_id from ${TABLE}`),
        );
        const write = await outcome(t.pg.query(`delete from ${TABLE}`));
        await evidence(
          'AC-RLS-01',
          'direct SELECT and DELETE as storeforge_app: permission denied (42501)',
          { select: read, delete: write },
          () => {
            expect(read).toBe('42501');
            expect(write).toBe('42501');
          },
        );
      });

      it('AC-RLS-02 and AC-RLS-03: the request role cannot read secret columns (or *) but can read the four allowed ones', async () => {
        const id = await seedRow(w.tenantA, w.alice);
        const denied: Record<string, string> = {};
        for (const column of [...SECRET_COLUMNS, '*'])
          denied[column] = await outcome(selectAs(w.alice, column, w.tenantA));
        const allowed = await selectAs(
          w.alice,
          'tenant_id, key_id, updated_at, updated_by',
          w.tenantA,
        );
        await clear();
        await evidence(
          'AC-RLS-02',
          'SELECT of each secret column and of * was permission denied (42501)',
          denied,
          () => {
            for (const code of Object.values(denied))
              expect(code).toBe('42501');
          },
        );
        await evidence(
          'AC-RLS-03',
          "the four allowed columns return the Owner's row",
          { columns: Object.keys(allowed[0] ?? {}), rows: allowed.length },
          () => {
            expect(allowed).toHaveLength(1);
            expect(allowed[0].key_id).toBe(id);
            expect(allowed[0].updated_by).toBe(w.alice);
          },
        );
      });

      it('AC-RLS-04 and AC-RLS-06: the atomic upsert inserts then replaces; the Owner can insert, update and delete', async () => {
        const first = keyId('test');
        const second = keyId('live');
        await upsertAs(w.alice, w.tenantA, first);
        const afterInsert = await rowOf(w.tenantA);
        await upsertAs(w.alice, w.tenantA, second, `${SYNTH_SECRET}2`);
        const afterReplace = await rowOf(w.tenantA);
        const count = await own((pg) =>
          pg.query<{ n: number }>(
            `select count(*)::int as n from ${TABLE} where tenant_id = $1`,
            [w.tenantA],
          ),
        );
        const removed = await asUser(t, w.alice, (tx) =>
          tx.execute(
            sql`delete from public.tenant_razorpay_config where tenant_id = ${w.tenantA}::uuid`,
          ),
        );
        const gone = await rowOf(w.tenantA);
        await evidence(
          'AC-RLS-04',
          'insert path then update path of one upsert statement; one row, complete new pair',
          {
            insertedKeyId: afterInsert?.key_id,
            replacedKeyId: afterReplace?.key_id,
            rows: count.rows[0].n,
            ciphertextChanged:
              afterInsert?.secret_ciphertext !==
              afterReplace?.secret_ciphertext,
          },
          () => {
            expect(afterInsert?.key_id).toBe(first);
            expect(afterReplace?.key_id).toBe(second);
            expect(count.rows[0].n).toBe(1);
            expect(afterReplace?.secret_ciphertext).not.toBe(
              afterInsert?.secret_ciphertext,
            );
            expect(afterReplace?.iv).not.toBe(afterInsert?.iv);
          },
        );
        await evidence(
          'AC-RLS-06',
          'Owner inserted, updated and deleted its own tenant row',
          {
            deleted: removed !== undefined,
            remaining: gone === undefined ? 0 : 1,
          },
          () => {
            expect(gone).toBeUndefined();
          },
        );
      });

      it('AC-RLS-07: tenant Admin and Staff cannot select, insert, update or delete', async () => {
        await seedRow(w.tenantA, w.alice);
        const before = await rowOf(w.tenantA);
        const results: Record<string, Record<string, string | number>> = {};
        for (const [who, uid] of [
          ['admin', w.members.writer],
          ['staff', x.staffA],
        ] as const) {
          const visible = (await selectAs(uid, 'tenant_id', w.tenantA)).length;
          const insert = await outcome(upsertAs(uid, w.tenantA, keyId()));
          const update = await asUser(
            t,
            uid,
            async (tx) =>
              rowsOf(
                await tx.execute(
                  sql`update public.tenant_razorpay_config set key_id = ${keyId()} where tenant_id = ${w.tenantA}::uuid returning tenant_id`,
                ),
              ).length,
          );
          const del = await asUser(
            t,
            uid,
            async (tx) =>
              rowsOf(
                await tx.execute(
                  sql`delete from public.tenant_razorpay_config where tenant_id = ${w.tenantA}::uuid returning tenant_id`,
                ),
              ).length,
          );
          results[who] = {
            visibleRows: visible,
            insert,
            updatedRows: update,
            deletedRows: del,
          };
        }
        const after = await rowOf(w.tenantA);
        await clear();
        await evidence(
          'AC-RLS-07',
          'Admin and Staff saw no rows, could not insert (42501), updated and deleted zero rows; the row is unchanged',
          results,
          () => {
            for (const r of Object.values(results))
              expect(r).toEqual({
                visibleRows: 0,
                insert: '42501',
                updatedRows: 0,
                deletedRows: 0,
              });
            expect(after).toEqual(before);
          },
        );
      });

      it('AC-RLS-08: the anon role has no rights', async () => {
        const r = await asDbRole('anon', (pg) =>
          outcome(pg.query(`select tenant_id from ${TABLE}`)),
        );
        await evidence(
          'AC-RLS-08',
          'SELECT as anon: permission denied (42501)',
          { select: r },
          () => expect(r).toBe('42501'),
        );
      });

      it('AC-RLS-09: a platform admin has no access through RLS', async () => {
        await seedRow(w.tenantA, w.alice);
        const visible = (await selectAs(w.superAdmin, 'tenant_id', w.tenantA))
          .length;
        const insert = await outcome(
          upsertAs(w.superAdmin, w.tenantA, keyId()),
        );
        await clear();
        await evidence(
          'AC-RLS-09',
          'platform admin saw zero rows and could not write (42501)',
          { visibleRows: visible, insert },
          () => {
            expect(visible).toBe(0);
            expect(insert).toBe('42501');
          },
        );
      });

      it("AC-RLS-10: an Owner cannot read, write or delete another tenant's row", async () => {
        const bId = await seedRow(w.tenantB, w.bob);
        const before = await rowOf(w.tenantB);
        const visible = (await selectAs(w.alice, 'tenant_id', w.tenantB))
          .length;
        const write = await outcome(upsertAs(w.alice, w.tenantB, keyId()));
        const del = await asUser(
          t,
          w.alice,
          async (tx) =>
            rowsOf(
              await tx.execute(
                sql`delete from public.tenant_razorpay_config where tenant_id = ${w.tenantB}::uuid returning tenant_id`,
              ),
            ).length,
        );
        const after = await rowOf(w.tenantB);
        await clear();
        await evidence(
          'AC-RLS-10',
          "ownerA saw zero rows of tenant B, could not write (42501) or delete; tenant B's row is unchanged",
          {
            visibleRows: visible,
            write,
            deletedRows: del,
            keyIdStillB: after?.key_id === bId,
          },
          () => {
            expect(visible).toBe(0);
            expect(write).toBe('42501');
            expect(del).toBe(0);
            expect(after).toEqual(before);
          },
        );
      });

      it('AC-RLS-11a: the predicate denies all four operations when session_user is authenticator (simulation, not real PostgREST)', async () => {
        await seedRow(w.tenantA, w.alice);
        const run = async (statement: string, params: unknown[] = []) =>
          own(async (pg) => {
            await pg.exec('set session authorization authenticator');
            try {
              await pg.exec('begin');
              await pg.exec('set local role authenticated');
              await pg.query(
                "select set_config('request.jwt.claim.sub', $1, true)",
                [w.alice],
              );
              const su = await pg.query<{ s: string }>(
                'select session_user as s',
              );
              const res = await pg.query(statement, params);
              await pg.exec('rollback');
              return {
                sessionUser: su.rows[0].s,
                rows: res.rows.length,
                affected: res.affectedRows ?? 0,
              };
            } catch (error) {
              await pg.exec('rollback').catch(() => undefined);
              return { sessionUser: 'authenticator', error: sqlstate(error) };
            } finally {
              await pg.exec('reset session authorization');
            }
          });
        const e = encryptSecret(SYNTH_SECRET, w.tenantA, KEY_ENV);
        const results = {
          select: await run(
            `select tenant_id from ${TABLE} where tenant_id = $1`,
            [w.tenantA],
          ),
          insert: await run(
            `insert into ${TABLE} (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_by) values ($1,$2,$3,$4,$5,$6,$7)`,
            [
              w.tenantB,
              keyId(),
              e.ciphertext,
              e.iv,
              e.authTag,
              e.keyVersion,
              w.alice,
            ],
          ),
          update: await run(
            `update ${TABLE} set key_id = $2 where tenant_id = $1`,
            [w.tenantA, keyId()],
          ),
          delete: await run(`delete from ${TABLE} where tenant_id = $1`, [
            w.tenantA,
          ]),
        };
        const untouched = await rowOf(w.tenantA);
        await clear();
        await evidence(
          'AC-RLS-11a',
          'SIMULATION ONLY (SET SESSION AUTHORIZATION authenticator): select returned no rows; insert denied; update and delete affected no rows. Not real PostgREST; see AC-RLS-11b',
          results,
          () => {
            expect(results.select).toMatchObject({
              sessionUser: 'authenticator',
              rows: 0,
            });
            expect(results.insert).toMatchObject({
              sessionUser: 'authenticator',
              error: '42501',
            });
            expect(results.update).toMatchObject({ rows: 0, affected: 0 });
            expect(results.delete).toMatchObject({ rows: 0, affected: 0 });
            expect(untouched).toBeDefined();
          },
        );
      });

      it('AC-RLS-12: the real application path (storeforge_app, then SET LOCAL ROLE authenticated) still works with the gate', async () => {
        const id = keyId();
        const sessionUser = await asUser(
          t,
          w.alice,
          async (tx) =>
            rowsOf<{ s: string }>(
              await tx.execute(sql`select session_user as s`),
            )[0].s,
        );
        await upsertAs(w.alice, w.tenantA, id);
        const visible = await selectAs(w.alice, 'key_id', w.tenantA);
        await clear();
        await evidence(
          'AC-RLS-12',
          'Owner save and read succeeded with session_user = storeforge_app',
          { sessionUser, keyId: visible[0]?.key_id },
          () => {
            expect(sessionUser).toBe('storeforge_app');
            expect(visible[0]?.key_id).toBe(id);
          },
        );
      });

      it('AC-RLS-13: a forged updated_by is rejected', async () => {
        const forged = await asUser(t, w.alice, (tx) => {
          const e = encryptSecret(SYNTH_SECRET, w.tenantA, KEY_ENV);
          return tx.execute(sql`insert into public.tenant_razorpay_config (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_by)
          values (${w.tenantA}::uuid, ${keyId()}, ${e.ciphertext}, ${e.iv}, ${e.authTag}, ${e.keyVersion}, ${w.bob}::uuid)`);
        }).then(
          () => 'ok',
          (error: unknown) => sqlstate(error) ?? 'error',
        );
        const rows = await rowOf(w.tenantA);
        await evidence(
          'AC-RLS-13',
          'insert with updated_by set to another user: row-level security violation (42501); nothing stored',
          { sqlstate: forged, rowStored: rows !== undefined },
          () => {
            expect(forged).toBe('42501');
            expect(rows).toBeUndefined();
          },
        );
      });

      it('AC-RLS-14: a suspended tenant and a disabled membership are denied', async () => {
        const suspended = await outcome(upsertAs(x.ownerS, x.tenantS, keyId()));
        const disabled = await outcome(upsertAs(x.ownerD, x.tenantD, keyId()));
        const rows = await own((pg) => pg.query(`select 1 from ${TABLE}`));
        await evidence(
          'AC-RLS-14',
          'Owner of a suspended tenant and a disabled Owner could not write (42501)',
          { suspended, disabled, rowsWritten: rows.rows.length },
          () => {
            expect(suspended).toBe('42501');
            expect(disabled).toBe('42501');
            expect(rows.rows).toHaveLength(0);
          },
        );
      });

      it('AC-RLS-15: deleting a tenant cascades to its configuration row [PG half]', async () => {
        const owner = await createUser(
          t,
          'cascade.owner@example.test',
          'Cascade',
        );
        const tenantId = (
          await provision(t, w.superAdmin, owner, 'cascade-shop')
        ).tenant_id;
        await seedRow(tenantId, owner);
        const before = await rowOf(tenantId);
        await asUser(t, w.superAdmin, (tx) =>
          tx.execute(
            sql`select public.platform_delete_tenant(${tenantId}::uuid)`,
          ),
        );
        const after = await rowOf(tenantId);
        await evidence(
          'AC-RLS-15',
          'platform_delete_tenant removed the tenant and its configuration row',
          { rowBefore: before !== undefined, rowAfter: after !== undefined },
          () => {
            expect(before).toBeDefined();
            expect(after).toBeUndefined();
          },
        );
      });
    });
  },
);
