import { describe, expect, it } from 'vitest';
import { __testing } from '../src/modules/payments/credentials-crypto.js';
import { PAYMENTS_UNAVAILABLE_MESSAGE } from '../src/modules/payments/payments.service.js';
import { migrationsAvailable } from './support/pglite.js';
import {
  KEY_B64,
  keyId,
  SECRET,
  secretOf,
  usePaymentsHttp,
} from './support/payments-http.js';
import { vi } from 'vitest';

const URL = '/payments/razorpay';
const STATUS_KEYS = [
  'configured',
  'keyIdMasked',
  'mode',
  'updatedAt',
  'updatedByName',
];

describe.skipIf(!migrationsAvailable)(
  'GET, PUT and DELETE /payments/razorpay (HTTP e2e)',
  () => {
    const h = usePaymentsHttp();
    const owner = () => h.w.alice;
    const org = () => h.w.tenantA;
    const ownerClient = () => h.client(owner(), org());

    describe('read, save, replace, remove', () => {
      it('AC-API-01: GET with nothing saved returns exactly { configured: false }', async () => {
        await h.clear();
        const res = await (await ownerClient()).get(URL);
        await h.evidence(
          'AC-API-01',
          'api-evidence',
          'GET with nothing saved: 200, data is exactly { configured: false }',
          { status: res.status, data: res.body.data },
          () => {
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ configured: false });
          },
        );
      });

      it('AC-API-03: PUT saves and returns the safe status shape, never the secret', async () => {
        await h.clear();
        const id = keyId('test');
        const res = await h.put(owner(), org(), { keyId: id });
        await h.evidence(
          'AC-API-03',
          'api-evidence',
          'PUT 200; body is the safe status; the secret is absent',
          { status: res.status, data: res.body.data },
          () => {
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({
              configured: true,
              keyIdMasked: `${id.slice(0, 9)}••••${id.slice(-4)}`,
              mode: 'test',
              updatedByName: 'Alice Owner',
            });
            expect(Object.keys(res.body.data).sort()).toEqual(
              [...STATUS_KEYS].sort(),
            );
            expect(JSON.stringify(res.body)).not.toContain(SECRET);
          },
        );
      });

      it('AC-API-02: GET after saving returns exactly the five safe fields', async () => {
        await h.clear();
        const id = keyId('live');
        await h.put(owner(), org(), { keyId: id });
        const res = await (await ownerClient()).get(URL);
        await h.evidence(
          'AC-API-02',
          'api-evidence',
          'GET configured: exactly configured, keyIdMasked, mode, updatedAt, updatedByName',
          {
            status: res.status,
            keys: Object.keys(res.body.data).sort(),
            mode: res.body.data.mode,
          },
          () => {
            expect(res.status).toBe(200);
            expect(Object.keys(res.body.data).sort()).toEqual(
              [...STATUS_KEYS].sort(),
            );
            expect(res.body.data.mode).toBe('live');
            expect(new Date(res.body.data.updatedAt).getTime()).not.toBeNaN();
          },
        );
      });

      it('AC-API-04: PUT replaces the complete pair atomically', async () => {
        await h.clear();
        const first = { keyId: keyId('test'), keySecret: secretOf(1) };
        const second = { keyId: keyId('live'), keySecret: secretOf(2) };
        await h.put(owner(), org(), first);
        const before = await h.row(org());
        const res = await h.put(owner(), org(), second);
        const after = await h.row(org());
        const plain = __testing.decryptSecret(
          {
            ciphertext: String(after?.secret_ciphertext),
            iv: String(after?.iv),
            authTag: String(after?.auth_tag),
            keyVersion: Number(after?.key_version),
          },
          org(),
        );
        await h.evidence(
          'AC-API-04',
          'api-evidence',
          'second PUT replaced key_id, ciphertext, IV and tag together; one row',
          {
            status: res.status,
            rows: await h.count(),
            mode: res.body.data?.mode,
          },
          () => {
            expect(res.status).toBe(200);
            expect(after?.key_id).toBe(second.keyId);
            expect(plain).toBe(second.keySecret);
            expect(after?.secret_ciphertext).not.toBe(
              before?.secret_ciphertext,
            );
            expect(after?.iv).not.toBe(before?.iv);
            expect(res.body.data.mode).toBe('live');
          },
        );
      });

      it('AC-API-10: DELETE hard-deletes the row and returns { configured: false }', async () => {
        await h.put(owner(), org());
        const res = await (await ownerClient()).delete(URL);
        const gone = await h.row(org());
        await h.evidence(
          'AC-API-10',
          'api-evidence',
          'DELETE 200 { configured: false }; the row no longer exists',
          {
            status: res.status,
            data: res.body.data,
            rowExists: gone !== undefined,
          },
          () => {
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ configured: false });
            expect(gone).toBeUndefined();
          },
        );
      });

      it('AC-API-11: DELETE is idempotent when nothing is saved', async () => {
        await h.clear();
        const c = await ownerClient();
        const first = await c.delete(URL);
        const second = await c.delete(URL);
        await h.evidence(
          'AC-API-11',
          'api-evidence',
          'two DELETEs with nothing saved both returned 200 { configured: false }',
          { first: first.status, second: second.status },
          () => {
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(second.body.data).toEqual({ configured: false });
          },
        );
      });

      it('AC-ENC-06 and AC-ENC-08: the stored value is ciphertext, never the plaintext, with key_version 1', async () => {
        await h.clear();
        await h.put(owner(), org());
        const row = await h.row(org());
        const cipher = String(row?.secret_ciphertext);
        const raw = Buffer.from(cipher, 'base64').toString('latin1');
        await h.evidence(
          'AC-ENC-06',
          'database-evidence',
          'stored ciphertext differs from, and contains neither the text nor the bytes of, the plaintext',
          {
            ciphertextLength: cipher.length,
            ivLength: String(row?.iv).length,
            tagLength: String(row?.auth_tag).length,
          },
          () => {
            expect(cipher).not.toBe(SECRET);
            expect(cipher).not.toContain(SECRET);
            expect(raw).not.toContain(SECRET);
            expect(
              Object.values(row ?? {})
                .map(String)
                .join('|'),
            ).not.toContain(SECRET);
          },
        );
        await h.evidence(
          'AC-ENC-08',
          'database-evidence',
          'key_version stored as 1',
          { keyVersion: row?.key_version },
          () => {
            expect(Number(row?.key_version)).toBe(1);
          },
        );
      });
    });

    describe('validation', () => {
      it('AC-API-05 and AC-ORG-09: unknown fields, including tenantId, are rejected and nothing is written', async () => {
        await h.clear();
        const c = await ownerClient();
        const extra = await c.put(URL, {
          keyId: keyId(),
          keySecret: SECRET,
          tenantId: h.w.tenantB,
        });
        const other = await c.put(URL, {
          keyId: keyId(),
          keySecret: SECRET,
          mode: 'live',
        });
        await h.evidence(
          'AC-API-05',
          'api-evidence',
          'PUT with an unknown field: 400 VALIDATION_ERROR, zero rows',
          {
            tenantId: extra.status,
            other: other.status,
            code: extra.body.error?.code,
            rows: await h.count(),
          },
          () => {
            expect(extra.status).toBe(400);
            expect(other.status).toBe(400);
            expect(extra.body.error.code).toBe('VALIDATION_ERROR');
            expect(JSON.stringify(extra.body)).not.toContain(SECRET);
          },
        );
        await h.evidence(
          'AC-ORG-09',
          'api-evidence',
          'a tenantId in the body is a 400 and no row exists for either tenant',
          {
            bodyTenantId: extra.status,
            rowA: (await h.row(org())) !== undefined,
            rowB: (await h.row(h.w.tenantB)) !== undefined,
          },
          async () => {
            expect(extra.status).toBe(400);
            expect(await h.count()).toBe(0);
          },
        );
        const viaUrl = await (
          await h.client(owner(), org())
        ).put(`${URL}/${h.w.tenantB}`, { keyId: keyId(), keySecret: SECRET });
        expect(viaUrl.status).toBe(404);
      });

      it('AC-API-06: the Key ID pattern is enforced; a 7-character suffix fails and an 8-character suffix passes', async () => {
        await h.clear();
        const results: Record<string, number> = {};
        for (const [label, id] of [
          ['malformed', 'not-a-key'],
          ['unknown-mode', 'rzp_demo_abcdefgh'],
          ['suffix7', 'rzp_test_abcdefg'],
          ['suffix8', 'rzp_test_abcdefgh'],
          ['live', 'rzp_live_ABCDEFGH12'],
        ] as const)
          results[label] = (await h.put(owner(), org(), { keyId: id })).status;
        await h.evidence(
          'AC-API-06',
          'api-evidence',
          'malformed, unknown-mode and 7-character-suffix Key IDs: 400; 8-character and live: 200',
          results,
          () => {
            expect(results).toEqual({
              malformed: 400,
              'unknown-mode': 400,
              suffix7: 400,
              suffix8: 200,
              live: 200,
            });
          },
        );
      });

      it('AC-API-07: the secret rule is enforced at 15, 16, 128 and 129 characters; padding and symbols are rejected', async () => {
        await h.clear();
        const at = (n: number) => 'a'.repeat(n);
        const results: Record<string, number> = {};
        for (const [label, secret] of [
          ['len15', at(15)],
          ['len16', at(16)],
          ['len128', at(128)],
          ['len129', at(129)],
          ['padded', ` ${at(16)}`],
          ['symbol', `${at(15)}_`],
          ['number', 1234567890123456 as unknown as string],
        ] as const)
          results[label] = (
            await h.put(owner(), org(), { keySecret: secret })
          ).status;
        const stored = await h.row(org());
        await h.evidence(
          'AC-API-07',
          'api-evidence',
          '16 and 128 accepted; 15, 129, padded, symbol and non-string rejected (400)',
          results,
          () => {
            expect(results).toEqual({
              len15: 400,
              len16: 200,
              len128: 200,
              len129: 400,
              padded: 400,
              symbol: 400,
              number: 400,
            });
            expect(
              String(stored?.secret_ciphertext).length,
            ).toBeLessThanOrEqual(2048);
          },
        );
      });

      it('AC-API-17: both fields are required; each missing alone is a 400 and writes nothing', async () => {
        await h.clear();
        const c = await ownerClient();
        const noSecret = await c.put(URL, { keyId: keyId() });
        const noKeyId = await c.put(URL, { keySecret: SECRET });
        const empty = await c.put(URL, {});
        await h.evidence(
          'AC-API-17',
          'api-evidence',
          'missing keySecret, missing keyId and an empty body: 400 each; zero rows',
          {
            noSecret: noSecret.status,
            noKeyId: noKeyId.status,
            empty: empty.status,
            rows: await h.count(),
          },
          async () => {
            for (const r of [noSecret, noKeyId, empty])
              expect(r.status).toBe(400);
            expect(await h.count()).toBe(0);
          },
        );
      });
    });

    describe('failure keeps the existing configuration', () => {
      it('AC-API-08: an invalid replacement and an unavailable key both leave the row byte-identical', async () => {
        await h.clear();
        await h.put(owner(), org());
        const before = await h.row(org());
        const invalid = await h.put(owner(), org(), {
          keyId: 'rzp_test_short',
        });
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
        const unavailable = await h.put(owner(), org());
        const after = await h.row(org());
        await h.evidence(
          'AC-API-08',
          'database-evidence',
          'a 400 and a 503 replacement left key_id, ciphertext, IV, tag and updated_at unchanged',
          {
            invalid: invalid.status,
            unavailable: unavailable.status,
            unchanged: JSON.stringify(before) === JSON.stringify(after),
          },
          () => {
            expect(invalid.status).toBe(400);
            expect(unavailable.status).toBe(503);
            expect(after).toEqual(before);
          },
        );
      });

      it('AC-API-09a: parallel PUTs never leave a mixed pair (serialized by PGlite)', async () => {
        await h.clear();
        const pairs = Array.from({ length: 8 }, (_, i) => ({
          keyId: keyId(i % 2 ? 'live' : 'test'),
          keySecret: secretOf(i),
        }));
        const results = await Promise.all(
          pairs.map((p) => h.put(owner(), org(), p)),
        );
        const row = await h.row(org());
        const plain = __testing.decryptSecret(
          {
            ciphertext: String(row?.secret_ciphertext),
            iv: String(row?.iv),
            authTag: String(row?.auth_tag),
            keyVersion: Number(row?.key_version),
          },
          org(),
        );
        const winner = pairs.find((p) => p.keyId === row?.key_id);
        await h.evidence(
          'AC-API-09a',
          'database-evidence',
          'SERIALIZED (PGlite, one connection): 8 parallel PUTs; the stored key_id and decrypted secret belong to one submitted pair. Not a multi-connection race (AC-API-09b)',
          { statuses: results.map((r) => r.status), rows: await h.count() },
          () => {
            expect(results.every((r) => r.status === 200)).toBe(true);
            expect(winner).toBeDefined();
            expect(plain).toBe(winner?.keySecret);
          },
        );
      });
    });

    describe('encryption key handling', () => {
      const variants: [string, string, () => void][] = [
        [
          'AC-KEY-01',
          'key missing',
          () => {
            vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
          },
        ],
        [
          'AC-KEY-02',
          'key not base64',
          () => {
            vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '%%%not base64%%%');
          },
        ],
        [
          'AC-KEY-03',
          'key not 32 bytes',
          () => {
            vi.stubEnv(
              'CREDENTIALS_ENCRYPTION_KEY_V1',
              Buffer.alloc(16, 7).toString('base64'),
            );
          },
        ],
        [
          'AC-KEY-04',
          'CURRENT unknown version',
          () => {
            vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_CURRENT', '9');
          },
        ],
      ];
      it.each(variants)(
        '%s: %s gives 503 PAYMENTS_UNAVAILABLE and no row',
        async (acId, label, setup) => {
          await h.clear();
          setup();
          const res = await h.put(owner(), org());
          const rows = await h.count();
          await h.evidence(
            acId,
            'api-evidence',
            `${label}: PUT is 503 PAYMENTS_UNAVAILABLE with the exact message; zero rows`,
            {
              status: res.status,
              code: res.body.error?.code,
              message: res.body.message,
              rows,
            },
            () => {
              expect(res.status).toBe(503);
              expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
              expect(res.body.message).toBe(PAYMENTS_UNAVAILABLE_MESSAGE);
              expect(rows).toBe(0);
              expect(JSON.stringify(res.body)).not.toContain(KEY_B64);
            },
          );
        },
      );

      it('AC-KEY-05: the application serves requests without the key (lazy validation)', async () => {
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_CURRENT', '');
        const res = await (await ownerClient()).get(URL);
        await h.evidence(
          'AC-KEY-05',
          'logs',
          `application built and serving with no key variables set; GET ${URL} answered ${res.status}`,
          `application built without the key variables; GET ${URL} -> ${res.status}\n`,
          () => {
            expect(res.status).toBe(200);
          },
        );
      });

      it('AC-KEY-06 and AC-KEY-07: GET and DELETE work without the key', async () => {
        await h.clear();
        await h.put(owner(), org());
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_CURRENT', '');
        const c = await ownerClient();
        const got = await c.get(URL);
        const del = await c.delete(URL);
        await h.evidence(
          'AC-KEY-06',
          'api-evidence',
          'GET with the key unset: 200 with the saved status',
          { status: got.status, configured: got.body.data?.configured },
          () => {
            expect(got.status).toBe(200);
            expect(got.body.data.configured).toBe(true);
          },
        );
        await h.evidence(
          'AC-KEY-07',
          'api-evidence',
          'DELETE with the key unset: 200 { configured: false }',
          { status: del.status, data: del.body.data },
          () => {
            expect(del.status).toBe(200);
            expect(del.body.data).toEqual({ configured: false });
          },
        );
      });

      it('AC-KEY-08: a key failure logs only its category, never a key, secret or stack', async () => {
        await h.clear();
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
        h.logs.clear();
        await h.put(owner(), org());
        const warns = h.logs.entries.filter((e) => e.level === 'warn');
        const text = h.logs.text();
        await h.evidence(
          'AC-KEY-08',
          'logs',
          `captured application log: ${JSON.stringify(warns.map((w) => w.message))}`,
          `${JSON.stringify(warns.map((w) => w.message))}\n`,
          () => {
            expect(warns.map((w) => w.message)).toContainEqual({
              category: 'key_missing',
            });
            expect(text).not.toContain(KEY_B64);
            expect(text).not.toContain(SECRET);
            expect(text).not.toMatch(/CREDENTIALS_ENCRYPTION_KEY/);
            expect(text).not.toMatch(/\n\s+at /);
          },
        );
      });
    });

    describe('throttling and events', () => {
      it('AC-API-12: PUT is limited by @Throttle(SENSITIVE): the 11th request in a minute is a 429', async () => {
        const ip = '10.201.0.12';
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++)
          statuses.push((await h.put(owner(), org(), {}, ip)).status);
        await h.evidence(
          'AC-API-12',
          'api-evidence',
          `PUT x11 from one client: ${statuses.join(',')}`,
          { statuses },
          () => {
            expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
            expect(statuses[10]).toBe(429);
          },
        );
      });

      it('AC-API-13: DELETE is limited by @Throttle(SENSITIVE): the 11th request in a minute is a 429', async () => {
        const c = await h.client(owner(), org(), '10.201.0.13');
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++)
          statuses.push((await c.delete(URL)).status);
        await h.evidence(
          'AC-API-13',
          'api-evidence',
          `DELETE x11 from one client: ${statuses.join(',')}`,
          { statuses },
          () => {
            expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
            expect(statuses[10]).toBe(429);
          },
        );
      });

      it('AC-LOG-01 and AC-LOG-02: save, replace and remove each emit one event with exactly four fields', async () => {
        await h.clear();
        const c = await ownerClient();
        h.logs.clear();
        await h.put(owner(), org());
        await h.put(owner(), org());
        await c.delete(URL);
        await c.delete(URL);
        const events = h.logs.entries
          .filter(
            (e) =>
              e.level === 'log' &&
              typeof e.message === 'object' &&
              e.message !== null &&
              'action' in (e.message as object),
          )
          .map((e) => e.message as Record<string, unknown>);
        await h.evidence(
          'AC-LOG-01',
          'logs',
          'save, replace, remove: one event each; the second DELETE (nothing to remove) logs none',
          events,
          () => {
            expect(events.map((e) => e.action)).toEqual([
              'save',
              'replace',
              'remove',
            ]);
          },
        );
        await h.evidence(
          'AC-LOG-02',
          'logs',
          'each event has exactly actorUserId, tenantId, action, timestamp',
          events,
          () => {
            for (const e of events) {
              expect(Object.keys(e).sort()).toEqual([
                'action',
                'actorUserId',
                'tenantId',
                'timestamp',
              ]);
              expect(e.actorUserId).toBe(owner());
              expect(e.tenantId).toBe(org());
            }
          },
        );
      });
    });
  },
);
