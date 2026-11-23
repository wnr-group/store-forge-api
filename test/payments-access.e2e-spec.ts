import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  createUser,
  migrationsAvailable,
  provision,
} from './support/pglite.js';
import {
  KEY_B64,
  keyId,
  SECRET,
  TABLE,
  usePaymentsHttp,
} from './support/payments-http.js';

const URL = '/payments/razorpay';
const METHODS = ['get', 'put', 'delete'] as const;
const BODY = () => ({ keyId: keyId(), keySecret: SECRET });
const FLAG = /customer_?auth/i;

describe.skipIf(!migrationsAvailable)(
  'payments: organization header, permissions, tenant isolation and secret protection (HTTP e2e)',
  () => {
    const h = usePaymentsHttp();
    const send = (
      method: (typeof METHODS)[number],
      user: string | null,
      headers: Record<string, string> = {},
    ) => h.raw(method, user, headers, method === 'put' ? BODY() : undefined);

    describe('X-Organization-Id is required', () => {
      it('AC-ORG-01, AC-ORG-02 and AC-ORG-03: a missing header is a 400 ORGANIZATION_REQUIRED and changes nothing', async () => {
        await h.clear();
        await h.put(h.w.alice, h.w.tenantA);
        const before = await h.row(h.w.tenantA);
        const res = {
          get: await send('get', h.w.alice),
          put: await send('put', h.w.alice),
          delete: await send('delete', h.w.alice),
        };
        const after = await h.row(h.w.tenantA);
        const seen = Object.fromEntries(
          Object.entries(res).map(([k, r]) => [
            k,
            { status: r.status, code: r.body.error?.code },
          ]),
        );
        for (const [id, m] of [
          ['AC-ORG-01', 'get'],
          ['AC-ORG-02', 'put'],
          ['AC-ORG-03', 'delete'],
        ] as const)
          await h.evidence(
            id,
            'api-evidence',
            `${m.toUpperCase()} without the header: 400 ORGANIZATION_REQUIRED; the existing row is unchanged`,
            seen[m],
            () => {
              expect(res[m].status).toBe(400);
              expect(res[m].body.error.code).toBe('ORGANIZATION_REQUIRED');
              expect(after).toEqual(before);
            },
          );
      });

      it('AC-ORG-04: a blank or whitespace header is a 400 on all three routes', async () => {
        const seen: Record<string, number> = {};
        for (const m of METHODS)
          for (const value of ['', '   '])
            seen[`${m}:${JSON.stringify(value)}`] = (
              await send(m, h.w.alice, { 'X-Organization-Id': value })
            ).status;
        await h.evidence(
          'AC-ORG-04',
          'api-evidence',
          'empty and whitespace-only headers: 400 on GET, PUT and DELETE',
          seen,
          () => {
            for (const status of Object.values(seen)) expect(status).toBe(400);
          },
        );
      });

      it('AC-ORG-05: a multi-organization Owner without the header gets a 400 and no row appears in any organization', async () => {
        await h.clear();
        const res = await send('put', h.x.multi);
        const rows = {
          one: await h.row(h.x.orgOne),
          two: await h.row(h.x.orgTwo),
        };
        await h.evidence(
          'AC-ORG-05',
          'api-evidence',
          'PUT without the header as an Owner of two organizations: 400; zero rows in both',
          {
            status: res.status,
            rowOne: rows.one !== undefined,
            rowTwo: rows.two !== undefined,
          },
          () => {
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
            expect(rows.one).toBeUndefined();
            expect(rows.two).toBeUndefined();
          },
        );
      });

      it('AC-ORG-06: a user who is staff in their first organization gets 400, not 403, without the header', async () => {
        const res = await send('get', h.x.mixed);
        await h.evidence(
          'AC-ORG-06',
          'api-evidence',
          'GET without the header as staff-in-first, Owner-in-second: 400 (the header check precedes the permission check)',
          { status: res.status, code: res.body.error?.code },
          () => {
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('ORGANIZATION_REQUIRED');
          },
        );
      });

      it('AC-ORG-07: an explicit valid header resolves the named organization, and only it', async () => {
        await h.clear();
        const id = keyId();
        const res = await h.put(h.x.multi, h.x.orgTwo, { keyId: id });
        const rows = {
          one: await h.row(h.x.orgOne),
          two: await h.row(h.x.orgTwo),
        };
        const mixedOwned = await h.put(h.x.mixed, h.x.mixedOwnerOrg);
        await h.evidence(
          'AC-ORG-07',
          'api-evidence',
          'PUT with the second organization named: the row exists only there; the mixed user can save in the organization they own',
          {
            status: res.status,
            inOne: rows.one !== undefined,
            inTwo: rows.two !== undefined,
            mixedOwned: mixedOwned.status,
          },
          () => {
            expect(res.status).toBe(200);
            expect(rows.one).toBeUndefined();
            expect(rows.two?.key_id).toBe(id);
            expect(mixedOwned.status).toBe(200);
          },
        );
      });

      it('AC-ORG-08: an organization the user does not belong to is inaccessible and nothing is read or written', async () => {
        await h.clear();
        await h.put(h.w.bob, h.w.tenantB);
        const before = await h.row(h.w.tenantB);
        const res = {
          get: await send('get', h.w.alice, {
            'X-Organization-Id': h.w.tenantB,
          }),
          put: await send('put', h.w.alice, {
            'X-Organization-Id': h.w.tenantB,
          }),
          unknown: await send('get', h.w.alice, {
            'X-Organization-Id': randomUUID(),
          }),
        };
        const after = await h.row(h.w.tenantB);
        const seen = Object.fromEntries(
          Object.entries(res).map(([k, r]) => [k, r.status]),
        );
        await h.evidence(
          'AC-ORG-08',
          'api-evidence',
          "a non-member naming another organization (or an unknown id) is refused; tenant B's row is unchanged and was not returned",
          seen,
          () => {
            for (const r of Object.values(res)) {
              expect(r.status).toBe(403);
              expect(JSON.stringify(r.body)).not.toMatch(/rzp_/);
            }
            expect(after).toEqual(before);
          },
        );
      });

      it('AC-ORG-10: every other @OrgScoped route still falls back to the first organization without the header', async () => {
        const res = await (await h.client(h.x.multi)).get('/store');
        expect(res.status).toBe(200);
        expect(res.body.data.slug).toBe('multi-one');
      });

      it('AC-ORG-11: an unauthenticated request is a 401 with or without the header', async () => {
        const seen: Record<string, number> = {};
        for (const m of METHODS) {
          seen[`${m}:noHeader`] = (await send(m, null)).status;
          seen[`${m}:header`] = (
            await send(m, null, { 'X-Organization-Id': h.w.tenantA })
          ).status;
        }
        await h.evidence(
          'AC-ORG-11',
          'api-evidence',
          'no token: 401 on every route, with and without X-Organization-Id',
          seen,
          () => {
            for (const status of Object.values(seen)) expect(status).toBe(401);
          },
        );
      });
    });

    describe('Owner-only permission and tenant isolation', () => {
      /** One probe: all three routes as  naming , with both tenants' rows compared before and after. */
      const probe = async (user: string | null, org = h.w.tenantA) => {
        await h.clear();
        await h.put(h.w.alice, h.w.tenantA);
        await h.put(h.w.bob, h.w.tenantB);
        const before = {
          a: await h.row(h.w.tenantA),
          b: await h.row(h.w.tenantB),
        };
        const res = {
          get: await send('get', user, { 'X-Organization-Id': org }),
          put: await send('put', user, { 'X-Organization-Id': org }),
          delete: await send('delete', user, { 'X-Organization-Id': org }),
        };
        const after = {
          a: await h.row(h.w.tenantA),
          b: await h.row(h.w.tenantB),
        };
        return {
          res,
          unchanged: JSON.stringify(before) === JSON.stringify(after),
          before,
          after,
          statuses: Object.fromEntries(
            Object.entries(res).map(([k, r]) => [k, r.status]),
          ),
        };
      };
      const deny = async (
        acId: string,
        label: string,
        expected: number,
        users: [string, string | null][],
        org = h.w.tenantA,
        errorCode?: string,
      ) => {
        const probes: Record<string, Awaited<ReturnType<typeof probe>>> = {};
        for (const [name, user] of users) probes[name] = await probe(user, org);
        const seen = Object.fromEntries(
          Object.entries(probes).map(([k, v]) => [k, v.statuses]),
        );
        const summary = `${label}: ${expected} on GET, PUT and DELETE; both tenants' rows unchanged`;
        await h.evidence(acId, 'api-evidence', summary, seen, () => {
          for (const p of Object.values(probes)) {
            for (const r of Object.values(p.res)) {
              expect(r.status).toBe(expected);
              if (errorCode) expect(r.body.error.code).toBe(errorCode);
              expect(JSON.stringify(r.body)).not.toMatch(/rzp_|SYNTH/);
            }
            expect(p.after).toEqual(p.before);
          }
        });
      };

      it('AC-PERM-02: a tenant Admin is denied on all three routes', () =>
        deny('AC-PERM-02', 'tenant Admin', 403, [
          ['admin', h.w.members.writer],
        ]));
      it('AC-PERM-03: staff are denied, including staff with settings write', async () => {
        const writer = await createUser(
          h.t.db,
          'staff.settings@example.test',
          'Staff Settings',
        );
        await h.t.db.asOwner((pg) =>
          pg.query(
            "insert into memberships (tenant_id, user_id, role, permissions, status) values ($1,$2,'staff',$3::jsonb,'active')",
            [
              h.w.tenantA,
              writer,
              JSON.stringify({ settings: 'write', products: 'write' }),
            ],
          ),
        );
        await deny('AC-PERM-03', 'staff', 403, [
          ['staffWithSettingsWrite', writer],
          ['plainStaff', h.x.staffA],
        ]);
      });
      it('AC-PERM-04: anonymous requests are denied', () =>
        deny('AC-PERM-04', 'no token', 401, [['anonymous', null]]));
      // The plan's row expects 403. The existing, unchanged organization guard answers 404 NO_WORKSPACE for any user without
      // an active membership, and a platform admin can never be a member (a trigger forbids it). The request is denied and
      // returns no payments data either way; the 404 is recorded as the observed behaviour, not changed.
      it("AC-PERM-05: a platform admin and users without active membership are denied (observed 404 NO_WORKSPACE, not the plan's 403)", () =>
        deny(
          'AC-PERM-05',
          'platform admin and user without active membership',
          404,
          [
            ['superAdmin', h.w.superAdmin],
            ['admin', h.w.admin],
            ['userWithoutMembership', h.w.carol],
          ],
          h.w.tenantA,
          'NO_WORKSPACE',
        ));
      it('user without active membership is denied on all three routes with 404 NO_WORKSPACE and zero leaks', async () => {
        const probeResult = await probe(h.w.carol, h.w.tenantA);
        for (const [, res] of Object.entries(probeResult.res)) {
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NO_WORKSPACE');
          expect(JSON.stringify(res.body)).not.toMatch(/rzp_|SYNTH/);
        }
        expect(probeResult.after).toEqual(probeResult.before);
      });
      it('AC-PERM-06: an Owner of another tenant is denied on all three routes and tenant B is unchanged', () =>
        deny(
          'AC-PERM-06',
          'Owner of tenant A naming tenant B',
          403,
          [['ownerA', h.w.alice]],
          h.w.tenantB,
        ));
    });

    describe('secret protection', () => {
      it('AC-SEC-01, AC-SEC-02, AC-SEC-03 and AC-SEC-04: no secret, ciphertext, IV, tag or key in any response or log, including a forced 500', async () => {
        await h.clear();
        const c = await h.client(h.w.alice, h.w.tenantA, '10.202.0.1');
        h.logs.clear();
        const bodies: {
          label: string;
          kind: 'success' | 'error';
          text: string;
        }[] = [];
        const take = (
          label: string,
          kind: 'success' | 'error',
          r: { status: number; body: unknown },
        ) =>
          bodies.push({
            label: `${label} ${r.status}`,
            kind,
            text: JSON.stringify(r.body),
          });

        take('PUT', 'success', await c.put(URL, BODY()));
        const stored = await h.row(h.w.tenantA);
        const sentinels = [
          SECRET,
          KEY_B64,
          String(stored?.secret_ciphertext),
          String(stored?.iv),
          String(stored?.auth_tag),
        ];
        take('GET', 'success', await c.get(URL));
        take('PUT replace', 'success', await c.put(URL, BODY()));
        take(
          'PUT 400',
          'error',
          await c.put(URL, { keyId: 'bad', keySecret: SECRET }),
        );
        take(
          'PUT 400 secret',
          'error',
          await c.put(URL, { keyId: keyId(), keySecret: `${SECRET}!` }),
        );
        take(
          'PUT unknown field',
          'error',
          await c.put(URL, {
            keyId: keyId(),
            keySecret: SECRET,
            extra: SECRET,
          }),
        );
        take('401', 'error', await send('put', null));
        take(
          '403',
          'error',
          await send('put', h.w.members.writer, {
            'X-Organization-Id': h.w.tenantA,
          }),
        );
        take('400 org', 'error', await send('put', h.w.alice));
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', '');
        take('503', 'error', await c.put(URL, BODY()));
        vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_V1', KEY_B64);
        const throttled = await h.client(h.w.alice, h.w.tenantA, '10.202.0.2');
        let last = { status: 0, body: {} as unknown };
        for (let i = 0; i < 11; i++) last = await throttled.delete(URL);
        take('429', 'error', last);
        take('DELETE', 'success', await c.delete(URL));

        // A forced 500: the table disappears under the request, and the body carries the secret.
        await h.t.db.asOwner((pg) =>
          pg.query(`alter table ${TABLE} rename to trc_renamed`),
        );
        let forced: { status: number; body: unknown };
        try {
          forced = await c.put(URL, BODY());
        } finally {
          await h.t.db.asOwner((pg) =>
            pg.query(
              `alter table public.trc_renamed rename to tenant_razorpay_config`,
            ),
          );
        }
        take('forced 500', 'error', forced);

        const logText = h.logs.text();
        const leaks = (text: string) =>
          sentinels.filter((s) => text.includes(s)).length;
        const success = bodies.filter((b) => b.kind === 'success');
        const errors = bodies.filter((b) => b.kind === 'error');
        const summary = (rows: typeof bodies) =>
          rows
            .map(
              (b) =>
                `${b.label}: ${leaks(b.text)} leaks, ${b.text.length} bytes`,
            )
            .join('\n');

        await h.evidence(
          'AC-SEC-01',
          'logs',
          `${success.length} success responses scanned for 5 sentinels (secret, key, ciphertext, IV, tag)\n${summary(success)}\n`,
          `${success.length} success responses scanned for 5 sentinels\n${summary(success)}\n`,
          () => {
            expect(success.length).toBeGreaterThanOrEqual(4);
            for (const b of success) expect(leaks(b.text), b.label).toBe(0);
          },
        );
        await h.evidence(
          'AC-SEC-02',
          'logs',
          `${errors.length} error responses (400, 401, 403, 429, 503, forced 500) scanned\n${summary(errors)}\n`,
          `${errors.length} error responses scanned for 5 sentinels\n${summary(errors)}\n`,
          () => {
            expect(forced.status).toBe(500);
            expect(errors.map((b) => b.label.split(' ').pop())).toEqual(
              expect.arrayContaining([
                '400',
                '401',
                '403',
                '429',
                '503',
                '500',
              ]),
            );
            for (const b of errors) expect(leaks(b.text), b.label).toBe(0);
          },
        );
        await h.evidence(
          'AC-SEC-03',
          'logs',
          `application logger output (${h.logs.entries.length} entries) scanned for 5 sentinels: ${leaks(logText)} found\n`,
          `application logger output: ${h.logs.entries.length} entries scanned for 5 sentinels; ${leaks(logText)} found\n`,
          () => {
            expect(h.logs.entries.length).toBeGreaterThan(0);
            expect(leaks(logText)).toBe(0);
          },
        );
        await h.evidence(
          'AC-SEC-04',
          'logs',
          `forced 500 and several 400s carried the synthetic secret in the request body; the filter logged none of it (${h.logs.entries.filter((e) => e.level === 'error').length} error log entries)\n`,
          `forced 500 and 400s with the secret in the body: ${leaks(logText)} sentinel(s) in ${h.logs.entries.length} log entries\n`,
          () => {
            expect(h.logs.entries.some((e) => e.level === 'error')).toBe(true);
            expect(leaks(logText)).toBe(0);
            expect(logText).not.toMatch(/"keySecret"|keySecret:/);
          },
        );
      });
    });

    describe('database layer through the API, and the dormant flag', () => {
      it('AC-RLS-05 [layer:HTTP]: no response of any route carries a secret column', async () => {
        await h.clear();
        const c = await h.client(h.w.alice, h.w.tenantA);
        const bodies = [
          await c.put(URL, BODY()),
          await c.get(URL),
          await c.delete(URL),
        ].map((r) => JSON.stringify(r.body));
        for (const body of bodies) {
          expect(body).not.toMatch(
            /secret_ciphertext|secretCiphertext|auth_tag|authTag|key_version|keyVersion|"iv"/,
          );
          expect(body).not.toContain(SECRET);
        }
      });

      it('AC-RLS-12 [layer:HTTP]: the real application path works end to end with the PostgREST gate in place', async () => {
        await h.clear();
        const id = keyId();
        const put = await h.put(h.w.alice, h.w.tenantA, { keyId: id });
        const got = await (await h.client(h.w.alice, h.w.tenantA)).get(URL);
        expect(put.status).toBe(200);
        expect(got.body.data.configured).toBe(true);
        expect((await h.row(h.w.tenantA))?.key_id).toBe(id);
      });

      it('AC-RLS-15 [layer:HTTP]: deleting a tenant through the platform route removes its payments row', async () => {
        const owner = await createUser(
          h.t.db,
          'cascade.http@example.test',
          'Cascade Owner',
        );
        const tenantId = (
          await provision(h.t.db, h.w.superAdmin, owner, 'cascade-http')
        ).tenant_id;
        await h.put(owner, tenantId);
        const before = await h.row(tenantId);
        const del = await (
          await h.client(h.w.superAdmin)
        ).delete(`/platform/organizations/${tenantId}`);
        const after = await h.row(tenantId);
        expect(before).toBeDefined();
        expect(del.status).toBe(200);
        expect(after).toBeUndefined();
      });

      it('AC-DB-10 [layer:HTTP]: the flag cannot be changed through any existing update route by a platform admin, an Owner or an Admin', async () => {
        const sup = await h.client(h.w.superAdmin);
        const viaPlatform = await sup.patch(
          `/platform/organizations/${h.w.tenantA}`,
          { customerAuthEnabled: true },
        );
        const viaSnake = await sup.patch(
          `/platform/organizations/${h.w.tenantA}`,
          { customer_auth_enabled: true },
        );
        const owner = await (
          await h.client(h.w.alice, h.w.tenantA)
        ).patch('/store', { customerAuthEnabled: true });
        const admin = await (
          await h.client(h.w.members.writer, h.w.tenantA)
        ).patch('/store', { customerAuthEnabled: true });
        const flag = await h.t.db.asOwner((pg) =>
          pg.query<{ v: boolean }>(
            'select customer_auth_enabled as v from tenants where id = $1',
            [h.w.tenantA],
          ),
        );
        for (const r of [viaPlatform, viaSnake, owner, admin])
          expect(r.status).toBe(400);
        expect(flag.rows[0].v).toBe(false);
      });

      it('AC-DB-11: no existing tenant, organization, store or platform response exposes the flag', async () => {
        const sup = await h.client(h.w.superAdmin);
        const owner = await h.client(h.w.alice, h.w.tenantA);
        const reads = {
          'GET /organizations': await owner.get('/organizations'),
          'GET /organizations/current': await owner.get(
            '/organizations/current',
          ),
          'GET /store': await owner.get('/store'),
          'GET /platform/organizations': await sup.get(
            '/platform/organizations',
          ),
          'GET /platform/organizations/:id': await sup.get(
            `/platform/organizations/${h.w.tenantA}`,
          ),
          'GET /platform/overview': await sup.get('/platform/overview'),
        };
        const seen = Object.fromEntries(
          Object.entries(reads).map(([k, r]) => [
            k,
            {
              status: r.status,
              mentionsFlag: FLAG.test(JSON.stringify(r.body)),
            },
          ]),
        );
        await h.evidence(
          'AC-DB-11',
          'api-evidence',
          'six existing tenant, organization, store and platform reads: none mention the flag',
          seen,
          () => {
            for (const [route, r] of Object.entries(reads)) {
              expect(r.status, route).toBe(200);
              expect(JSON.stringify(r.body), route).not.toMatch(FLAG);
            }
          },
        );
      });
    });

    describe('documentation', () => {
      it('AC-REG-02: the anonymous public storefront still answers without a token', async () => {
        const { default: request } = await import('supertest');
        const res = await request(h.t.app.getHttpServer()).get(
          '/api/v1/public/storefronts/alpha-shop',
        );
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(/razorpay|rzp_/i);
      });

      it('AC-REG-13: the baseline routes are unchanged; the payments settings operations are exactly the reviewed set', async () => {
        const { default: request } = await import('supertest');
        const doc = (
          await request(h.t.app.getHttpServer()).get('/api/docs-json')
        ).body as { paths: Record<string, Record<string, unknown>> };
        const methods = ['get', 'post', 'patch', 'put', 'delete'];
        const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
          methods.filter((m) => item[m]).map((m) => `${m} ${path}`),
        );
        // The Owner's payment settings routes: exactly these.
        const payments = ops.filter((o) => o.includes(' /api/v1/payments/'));
        // The order lifecycle (migration 0045+) added the checkout, order-management and shopper payment routes.
        const orderRoutes = ops.filter(
          (o) =>
            /\/api\/v1\/orders(\/|$)/.test(o) ||
            o.includes('/public/stores/') ||
            o.includes('/api/v1/webhooks/') ||
            o.includes('/api/v1/shipping/') ||
            /\/api\/v1\/shipments(\/|$)/.test(o) ||
            o.includes('/api/v1/tax/'),
        );
        // 148 is the operation count of the baseline (origin/main) application, Store Forge Studio included.
        expect(ops.length - payments.length - orderRoutes.length).toBe(148);
        expect(payments.sort()).toEqual([
          'delete /api/v1/payments/razorpay',
          'get /api/v1/payments/cod',
          'get /api/v1/payments/razorpay',
          'get /api/v1/payments/refunds',
          'get /api/v1/payments/transactions',
          'get /api/v1/payments/transactions/{id}',
          'post /api/v1/payments/razorpay/verify',
          'post /api/v1/payments/refunds/{id}/sync',
          'post /api/v1/payments/transactions/{id}/refunds',
          'put /api/v1/payments/cod',
          'put /api/v1/payments/razorpay',
          'put /api/v1/payments/razorpay/enabled',
        ]);
      });

      it('AC-API-16: Swagger documents all three routes with the header, bearer auth and error responses', async () => {
        const { default: request } = await import('supertest');
        const doc = (
          await request(h.t.app.getHttpServer()).get('/api/docs-json')
        ).body as {
          paths: Record<
            string,
            Record<
              string,
              {
                summary?: string;
                description?: string;
                tags?: string[];
                security?: unknown[];
                parameters?: { name: string }[];
                responses: Record<string, unknown>;
              }
            >
          >;
        };
        const item = doc.paths['/api/v1/payments/razorpay'] ?? {};
        const seen = Object.fromEntries(
          METHODS.map((m) => [
            m,
            {
              summary: item[m]?.summary,
              responses: Object.keys(item[m]?.responses ?? {}),
              header: item[m]?.parameters?.some(
                (p) => p.name === 'X-Organization-Id',
              ),
              tags: item[m]?.tags,
            },
          ]),
        );
        await h.evidence(
          'AC-API-16',
          'api-evidence',
          'GET, PUT and DELETE /payments/razorpay are in the OpenAPI document with summary, description, tag, bearer auth, organization header and error responses',
          seen,
          () => {
            for (const m of METHODS) {
              const op = item[m];
              expect(op, m).toBeDefined();
              expect(op?.summary).toBeTruthy();
              expect(op?.description).toContain('REQUIRES');
              expect(op?.tags).toEqual(['payments']);
              expect(JSON.stringify(op?.security)).toContain('bearer');
              expect(
                op?.parameters?.some((p) => p.name === 'X-Organization-Id'),
              ).toBe(true);
              for (const code of ['200', '401', '403', '500'])
                expect(Object.keys(op?.responses ?? {})).toContain(code);
            }
            expect(Object.keys(item.put?.responses ?? {})).toEqual(
              expect.arrayContaining(['400', '429', '503']),
            );
            expect(Object.keys(item.delete?.responses ?? {})).toContain('429');
          },
        );
      });
    });
  },
);
