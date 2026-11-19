import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLUMNS_SQL,
  findSchemaDrift,
  type ColumnRow,
} from '../../src/database/schema-drift.js';
import { __testing } from '../../src/modules/payments/credentials-crypto.js';
import { captureEvidence } from '../support/qa-evidence/writer.js';

/**
 * REAL layer for the Razorpay credentials, against a REAL running API, Postgres, Supabase Auth and PostgREST.
 *
 * Environment label: `local-stack`. Unless QA_REAL_ENVIRONMENT says `hosted`, this runs on the ISOLATED LOCAL Supabase stack and
 * is local-dev evidence only; it is never hosted dev or staging evidence. Required variables: QA_REAL_API (API base URL
 * including the prefix), QA_REAL_SUPABASE_URL, QA_REAL_ANON_KEY, QA_REAL_DB_OWNER_URL (owner connection, read and test-row writes
 * only), QA_REAL_API_LOG (the running API's log file), QA_REAL_KEY_V1 (the API's encryption key, to decrypt in the test only),
 * QA_REAL_OWNER_EMAIL, QA_REAL_PASSWORD and QA_SYNTH_SECRET.
 */

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the REAL-layer spec`);
  return v;
};
const enabled = Boolean(process.env.QA_REAL_API);
const ENVIRONMENT =
  process.env.QA_REAL_ENVIRONMENT === 'hosted' ? 'hosted' : 'local-stack';
const TABLE = 'public.tenant_razorpay_config';

const evidence = (
  acId: string,
  folder: 'database-evidence' | 'api-evidence' | 'logs',
  actualResult: string,
  observed: object | string,
  assert: () => void,
) =>
  captureEvidence({
    acId,
    folder,
    layer: 'REAL',
    environment: ENVIRONMENT,
    actualResult,
    assert,
    content: () =>
      typeof observed === 'string'
        ? observed
        : { acId, layer: 'REAL', environment: ENVIRONMENT, observed },
  });

const keyId = (n: number) =>
  `rzp_test_real${String(n).padStart(2, '0')}${Date.now().toString(36)}`;

describe.skipIf(!enabled)(
  'payments on a real running stack [layer:REAL]',
  () => {
    let api: string;
    let supabase: string;
    let anon: string;
    let sql: ReturnType<typeof postgres>;
    let token: string;
    let tenantId: string;
    let ownerId: string;
    const secret = process.env.QA_SYNTH_SECRET ?? '';

    const apiCall = (method: string, path: string, body?: object) =>
      fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Organization-Id': tenantId,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const rest = async (
      method: string,
      query: string,
      body?: object,
      extra: Record<string, string> = {},
    ) => {
      const res = await fetch(
        `${supabase}/rest/v1/tenant_razorpay_config${query}`,
        {
          method,
          headers: {
            apikey: anon,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...extra,
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      return { status: res.status, body: await res.text() };
    };

    beforeAll(async () => {
      api = need('QA_REAL_API').replace(/\/$/, '');
      supabase = need('QA_REAL_SUPABASE_URL').replace(/\/$/, '');
      anon = need('QA_REAL_ANON_KEY');
      need('QA_REAL_API_LOG');
      need('QA_REAL_KEY_V1');
      if (secret.length < 16)
        throw new Error(
          'QA_SYNTH_SECRET is required (a per-run synthetic secret)',
        );
      sql = postgres(need('QA_REAL_DB_OWNER_URL'), {
        max: 2,
        prepare: false,
        ssl: false,
        onnotice: () => undefined,
      });
      const login = await fetch(
        `${supabase}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: { apikey: anon, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: need('QA_REAL_OWNER_EMAIL'),
            password: need('QA_REAL_PASSWORD'),
          }),
        },
      );
      const session = (await login.json()) as {
        access_token: string;
        user: { id: string };
      };
      token = session.access_token;
      ownerId = session.user.id;
      const [row] = await sql<
        { tenant_id: string }[]
      >`select tenant_id from memberships where user_id = ${ownerId}::uuid and role = 'owner' and status = 'active' limit 1`;
      tenantId = row.tenant_id;
      await sql.unsafe(`delete from ${TABLE} where tenant_id = '${tenantId}'`);
    });
    afterAll(async () => {
      if (sql) {
        await sql.unsafe(
          `delete from ${TABLE} where tenant_id = '${tenantId}'`,
        );
        await sql.end();
      }
    });

    it('AC-RLS-16 [layer:REAL]: the real grants and policies equal the migration, and the Drizzle schema matches the database', async () => {
      const grants = await sql<
        { grantee: string; privilege_type: string; cols: string }[]
      >`
      select grantee, privilege_type, string_agg(column_name, ',' order by column_name) as cols
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'tenant_razorpay_config' and grantee in ('authenticated', 'anon', 'public', 'storeforge_app')
      group by 1, 2 order by 1, 2`;
      const policies = await sql<
        {
          policyname: string;
          cmd: string;
          roles: string;
          qual: string | null;
          with_check: string | null;
        }[]
      >`
      select policyname, cmd, roles::text as roles, qual, with_check from pg_policies where tablename = 'tenant_razorpay_config' order by policyname`;
      const rls = await sql<
        { relrowsecurity: boolean }[]
      >`select relrowsecurity from pg_class where oid = 'public.tenant_razorpay_config'::regclass`;
      const columns = (await sql.unsafe(COLUMNS_SQL)) as unknown as ColumnRow[];
      const drift = findSchemaDrift(columns);
      const by = (g: string, p: string) =>
        grants.find((r) => r.grantee === g && r.privilege_type === p)?.cols;
      await evidence(
        'AC-RLS-16',
        'database-evidence',
        `${ENVIRONMENT}: real catalog queries on the migrated database match the migration; db:verify-schema logic reports ${drift.length} drift problem(s)`,
        {
          grants,
          policies: policies.map((p) => ({
            name: p.policyname,
            cmd: p.cmd,
            roles: p.roles,
            usesSessionUserGate: /session_user/i.test(
              `${p.qual ?? ''}${p.with_check ?? ''}`,
            ),
          })),
          rowLevelSecurity: rls[0].relrowsecurity,
          schemaDrift: drift,
        },
        () => {
          expect(by('authenticated', 'SELECT')).toBe(
            'key_id,tenant_id,updated_at,updated_by',
          );
          expect(by('authenticated', 'INSERT')).toBe(
            'auth_tag,iv,key_id,key_version,secret_ciphertext,tenant_id,updated_at,updated_by',
          );
          expect(by('authenticated', 'UPDATE')).toBe(
            'auth_tag,iv,key_id,key_version,secret_ciphertext,updated_at,updated_by',
          );
          expect(
            grants.filter((r) =>
              ['anon', 'public', 'storeforge_app'].includes(r.grantee),
            ),
          ).toEqual([]);
          expect(policies.map((p) => p.cmd).sort()).toEqual([
            'DELETE',
            'INSERT',
            'SELECT',
            'UPDATE',
          ]);
          for (const p of policies) {
            expect(p.roles).toContain('authenticated');
            // Postgres stores the predicate normalised, with SESSION_USER in upper case.
            expect(`${p.qual ?? ''}${p.with_check ?? ''}`).toMatch(
              /session_user\s*<>\s*'authenticator'/i,
            );
          }
          expect(rls[0].relrowsecurity).toBe(true);
          expect(drift).toEqual([]);
        },
      );
    });

    it('AC-RLS-11b [layer:REAL]: real PostgREST denies an Owner JWT on select, insert, update and delete, while the real API path works', async () => {
      const seededKeyId = keyId(0);
      await sql.unsafe(`delete from ${TABLE} where tenant_id = '${tenantId}'`);
      await sql`insert into public.tenant_razorpay_config (tenant_id, key_id, secret_ciphertext, iv, auth_tag, key_version, updated_by)
      values (${tenantId}::uuid, ${seededKeyId}, 'QUJD', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', 1, ${ownerId}::uuid)`;
      const before =
        await sql`select * from public.tenant_razorpay_config where tenant_id = ${tenantId}::uuid`;

      const results = {
        selectAllowedColumns: await rest('GET', '?select=tenant_id,key_id'),
        selectAll: await rest('GET', '?select=*'),
        selectSecret: await rest('GET', '?select=secret_ciphertext'),
        insert: await rest(
          'POST',
          '',
          {
            tenant_id: tenantId,
            key_id: keyId(1),
            secret_ciphertext: 'QUJD',
            iv: 'AAAAAAAAAAAAAAAA',
            auth_tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
            key_version: 1,
            updated_by: ownerId,
          },
          { Prefer: 'return=representation' },
        ),
        update: await rest(
          'PATCH',
          `?tenant_id=eq.${tenantId}`,
          { key_id: keyId(2) },
          { Prefer: 'return=representation' },
        ),
        delete: await rest('DELETE', `?tenant_id=eq.${tenantId}`, undefined, {
          Prefer: 'return=representation',
        }),
      };
      const after =
        await sql`select * from public.tenant_razorpay_config where tenant_id = ${tenantId}::uuid`;
      const viaApi = await apiCall('GET', '/payments/razorpay');
      const apiBody = (await viaApi.json()) as {
        data: { configured: boolean; keyIdMasked?: string };
      };

      const returnedData = (b: string) =>
        b.includes(seededKeyId) || /"tenant_id"\s*:/.test(b);
      const summary = Object.fromEntries(
        Object.entries(results).map(([k, r]) => [
          k,
          {
            status: r.status,
            returnedRowData: returnedData(r.body),
            bodyLength: r.body.length,
          },
        ]),
      );
      await evidence(
        'AC-RLS-11b',
        'api-evidence',
        `${ENVIRONMENT}: real PostgREST with an Owner JWT could neither read nor change the row; the real API path still returned it`,
        {
          postgrest: summary,
          rowUnchanged: JSON.stringify(before) === JSON.stringify(after),
          realApiPath: {
            status: viaApi.status,
            configured: apiBody.data.configured,
          },
        },
        () => {
          for (const [name, r] of Object.entries(results))
            expect(returnedData(r.body), name).toBe(false);
          expect(results.selectAll.status).toBeGreaterThanOrEqual(400);
          expect(results.selectSecret.status).toBeGreaterThanOrEqual(400);
          expect(results.insert.status).toBeGreaterThanOrEqual(400);
          expect(JSON.stringify(before)).toBe(JSON.stringify(after));
          expect(after).toHaveLength(1);
          expect(viaApi.status).toBe(200);
          expect(apiBody.data.configured).toBe(true);
        },
      );
    });

    it('AC-API-09b [layer:REAL] and AC-SEC-06 [layer:REAL]: 8 racing PUTs on real connections leave one complete pair, and the live API log never holds a secret', async () => {
      await sql.unsafe(`delete from ${TABLE} where tenant_id = '${tenantId}'`);
      const pairs = Array.from({ length: 8 }, (_, i) => ({
        keyId: keyId(10 + i),
        keySecret: `${secret}${String(i).padStart(2, '0')}`,
      }));
      const connections: number[] = [];
      const sampler = setInterval(() => {
        void sql<
          { n: number }[]
        >`select count(*)::int as n from pg_stat_activity where usename = 'storeforge_app'`
          .then((r) => connections.push(r[0].n))
          .catch(() => undefined);
      }, 15);
      const responses = await Promise.all(
        pairs.map((p) => apiCall('PUT', '/payments/razorpay', p)),
      );
      clearInterval(sampler);
      const statuses = responses.map((r) => r.status);
      const [row] = await sql<
        Record<string, string | number>[]
      >`select * from public.tenant_razorpay_config where tenant_id = ${tenantId}::uuid`;
      const plain = __testing.decryptSecret(
        {
          ciphertext: String(row.secret_ciphertext),
          iv: String(row.iv),
          authTag: String(row.auth_tag),
          keyVersion: Number(row.key_version),
        },
        tenantId,
        {
          CREDENTIALS_ENCRYPTION_KEY_V1: need('QA_REAL_KEY_V1'),
          CREDENTIALS_ENCRYPTION_KEY_CURRENT: '1',
        },
      );
      const winner = pairs.find((p) => p.keyId === row.key_id);
      const maxConnections = Math.max(0, ...connections);
      await evidence(
        'AC-API-09b',
        'database-evidence',
        `${ENVIRONMENT}: 8 concurrent PUTs through the real API on a pool of real connections (up to ${maxConnections} app-role connections seen); the stored key_id and decrypted secret belong to one submitted pair`,
        {
          statuses,
          maxAppRoleConnectionsObserved: maxConnections,
          winnerKeyId: row.key_id,
          pairMatches: winner?.keySecret === plain,
        },
        () => {
          expect(statuses.every((s) => s === 200)).toBe(true);
          expect(winner).toBeDefined();
          expect(plain).toBe(winner?.keySecret);
          expect(maxConnections).toBeGreaterThan(1);
        },
      );

      // The API has now handled requests whose bodies carried the secret: its own log must not.
      // The Nest console logger wraps lines in ANSI colour codes; strip them so the request lines can be matched.
      // eslint-disable-next-line no-control-regex
      const log = readFileSync(need('QA_REAL_API_LOG'), 'utf8').replace(
        /\u001b\[[0-9;]*m/g,
        '',
      );
      const sentinels = [
        secret,
        need('QA_REAL_KEY_V1'),
        String(row.secret_ciphertext),
        String(row.iv),
        String(row.auth_tag),
      ];
      const leaks = sentinels.filter((s) => log.includes(s)).length;
      const putLines = log
        .split('\n')
        .filter((l) => /\bPUT \/api\/v1\/payments\/razorpay\b/.test(l)).length;
      await evidence(
        'AC-SEC-06',
        'logs',
        `${ENVIRONMENT}: live API log scanned for 5 sentinels (secret, key, ciphertext, IV, tag): ${leaks} found; ${putLines} PUT request lines logged\nlog lines: ${log.split('\n').length}\n`,
        `${ENVIRONMENT}: live API log scanned for 5 sentinels: ${leaks} found\nlog lines scanned: ${log.split('\n').length}\nPUT /payments/razorpay request lines present in the log: ${putLines}\n`,
        () => {
          expect(putLines).toBeGreaterThanOrEqual(8);
          expect(leaks).toBe(0);
        },
      );
    });
  },
);
