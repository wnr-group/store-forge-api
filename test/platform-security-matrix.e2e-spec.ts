import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Read when the application module is loaded, so they are set before anything is imported.
const SECRETS = vi.hoisted(() => {
  const env = {
    RAZORPAY_PLATFORM_KEY_ID: 'rzp_test_MatrixKey001',
    RAZORPAY_PLATFORM_KEY_SECRET: 'matrix-key-secret-0123456789',
    RAZORPAY_PLATFORM_WEBHOOK_SECRET: 'matrix-webhook-secret-0123456789',
    CRON_SECRET: 'matrix-cron-secret-0123456789-0123456789',
  };
  Object.assign(process.env, env);
  return env;
});

import {
  PLATFORM_ROLE_PERMISSIONS,
  platformCan,
  type PlatformPermission,
} from '../src/common/constants/platform-permissions.js';
import {
  IS_PUBLIC,
  ORG_SCOPED,
  PLATFORM_ACCESS,
  REQUIRED_PERMISSION,
  type PlatformAccessOptions,
} from '../src/common/decorators/decorators.js';
import type { PlatformAdminRole } from '../src/database/schema/enums.js';
import { as, createTestApp, type TestApp } from './support/app.js';
import { TEST_ENV } from './support/test-env.js';
import {
  createPlatformAdmin,
  createTestDb,
  migrationsAvailable,
} from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Method = 'get' | 'post' | 'put' | 'delete' | 'patch';
interface Route {
  method: Method;
  path: string;
  label: string;
  platform?: PlatformAccessOptions;
  isPublic: boolean;
  orgScoped: boolean;
}

const UUID = '00000000-0000-4000-8000-0000000000aa';
const METHOD_NAMES: Partial<Record<number, Method>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};
const first = (v: unknown): string =>
  (Array.isArray(v) ? v[0] : v) === undefined
    ? ''
    : String(Array.isArray(v) ? v[0] : v);

/** Every route the running application really serves, read from its router: a route added later is covered without touching this file. */
function enumerate(t: TestApp): Route[] {
  const out: Route[] = [];
  const seen = new Set<unknown>();
  for (const mod of t.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!ctrl || seen.has(ctrl)) continue;
      seen.add(ctrl);
      const base = first(Reflect.getMetadata(PATH_METADATA, ctrl));
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const m = Reflect.getMetadata(METHOD_METADATA, handler) as
          number | undefined;
        const method = m === undefined ? undefined : METHOD_NAMES[m];
        if (!method) continue;
        const sub = first(Reflect.getMetadata(PATH_METADATA, handler));
        const path = `/api/v1/${[base, sub]
          .map((p) => p.replace(/^\/|\/$/g, ''))
          .filter(Boolean)
          .join('/')}`.replace(/:[A-Za-z]+/g, UUID);
        // Nest reads route metadata method first, then the class (getAllAndOverride).
        const meta = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) ??
            Reflect.getMetadata(key, ctrl)) as T | undefined;
        out.push({
          method,
          path,
          label: `${method.toUpperCase()} ${path.replace(new RegExp(UUID, 'g'), ':id')}`,
          platform: meta<PlatformAccessOptions>(PLATFORM_ACCESS),
          isPublic: meta<boolean>(IS_PUBLIC) === true,
          orgScoped: !!(
            meta<boolean>(ORG_SCOPED) || meta<string>(REQUIRED_PERMISSION)
          ),
        });
      }
    }
  }
  return out;
}

type Staff = PlatformAdminRole;
/** The contract, written independently of the guard: what each platform role may call. */
function allowed(o: PlatformAccessOptions, role: Staff): boolean {
  if (o.level === 'super_admin' && role !== 'super_admin') return false;
  if (o.permission)
    return platformCan(role, o.permission as PlatformPermission);
  return !!o.anyStaff || role === 'super_admin' || role === 'admin';
}

describe.skipIf(!migrationsAvailable)('platform security matrix (e2e)', () => {
  let t: TestApp;
  let w: World;
  let routes: Route[];
  let platform: Route[];
  let n = 0;
  const staff: Record<Staff, string> = {} as never;

  const call = async (
    r: Route,
    token: string | null,
    extra: Record<string, string> = {},
  ) => {
    const ip = `10.${Math.floor(++n / 60000) % 250}.${Math.floor(n / 250) % 250}.${n % 250}`;
    let req = request(t.app.getHttpServer())
      [r.method](r.path)
      .set('X-Forwarded-For', ip)
      .set(extra);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return r.method === 'get' || r.method === 'delete' ? req : req.send({});
  };
  const token = async (user: string, org?: string) =>
    (await as(t, user, org)).token;

  beforeAll(async () => {
    const db = await createTestDb();
    w = await seedWorld(db);
    staff.super_admin = w.superAdmin;
    staff.admin = w.admin;
    staff.billing_admin = await createPlatformAdmin(
      db,
      'billing@example.test',
      'billing_admin',
    );
    staff.support_admin = await createPlatformAdmin(
      db,
      'support@example.test',
      'support_admin',
    );
    t = await createTestApp(db);
    routes = enumerate(t);
    platform = routes.filter((r) => r.path.startsWith('/api/v1/platform'));
  });

  afterAll(async () => {
    await t?.close();
    await t?.db.close();
  });

  describe('every platform route', () => {
    it('is found, is protected, and is never public', () => {
      expect(platform.length).toBeGreaterThan(55);
      expect(platform.filter((r) => !r.platform).map((r) => r.label)).toEqual(
        [],
      );
      expect(platform.filter((r) => r.isPublic).map((r) => r.label)).toEqual(
        [],
      );
    });

    it('holds the role contract no matter how the code changes', () => {
      const labels = (pred: (r: Route, role: Staff) => boolean, role: Staff) =>
        platform
          .filter((r) => allowed(r.platform!, role) && pred(r, role))
          .map((r) => r.label);
      const writes = (r: Route) => r.method !== 'get';
      // Support is strictly read-only.
      expect(labels(writes, 'support_admin')).toEqual([]);
      // Billing may change nothing but billing.
      expect(
        labels(
          (r) => writes(r) && !/\/billing\//.test(r.path),
          'billing_admin',
        ),
      ).toEqual([]);
      // The Platform Admin never touches money, platform settings or other admins.
      expect(
        labels(
          (r) =>
            writes(r) && /\/platform\/(billing|admins|settings)/.test(r.path),
          'admin',
        ),
      ).toEqual([]);
      // Only the super admin manages admins.
      for (const role of ['admin', 'billing_admin', 'support_admin'] as Staff[])
        expect(
          labels((r) => writes(r) && /\/platform\/admins/.test(r.path), role),
        ).toEqual([]);
      // The audit log and monitoring belong to the operators.
      for (const role of ['billing_admin', 'support_admin'] as Staff[])
        expect(
          labels(
            (r) =>
              /\/platform\/(audit-logs|monitoring)/.test(r.path) &&
              !/organizations\//.test(r.path),
            role,
          ),
        ).toEqual([]);
      // Every role is allowed at least something, and nobody gets more than the super admin.
      for (const role of Object.keys(PLATFORM_ROLE_PERMISSIONS) as Staff[]) {
        expect(
          platform.filter((r) => allowed(r.platform!, role)).length,
        ).toBeGreaterThan(0);
        expect(
          platform.filter(
            (r) =>
              allowed(r.platform!, role) &&
              !allowed(r.platform!, 'super_admin'),
          ),
        ).toEqual([]);
      }
    });

    it('answers 401 without a session and 403 to a store owner and to a person with no organization', async () => {
      const owner = await token(w.alice);
      const nobody = await token(w.carol);
      const bad: string[] = [];
      for (const r of platform) {
        const anon = await call(r, null);
        if (anon.status !== 401)
          bad.push(`${r.label} anonymous -> ${anon.status}`);
        for (const [who, tok] of [
          ['owner', owner],
          ['nobody', nobody],
        ] as const) {
          const res = await call(r, tok);
          if (res.status !== 403)
            bad.push(`${r.label} ${who} -> ${res.status}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it('lets each platform role through exactly the routes its permissions allow, and refuses the rest with 403', async () => {
      const tenantsBefore = (
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from tenants'),
        )
      ).rows[0];
      const plansBefore = (
        await t.db.asOwner((pg) =>
          pg.query('select count(*)::int as n from plans'),
        )
      ).rows[0];
      const bad: string[] = [];
      let allowedCalls = 0;
      let deniedCalls = 0;
      for (const role of Object.keys(staff) as Staff[]) {
        const tok = await token(staff[role]);
        for (const r of platform) {
          const res = await call(r, tok);
          if (allowed(r.platform!, role)) {
            allowedCalls++;
            // Past the access check the route may still say 400, 404 or 409 to an empty request, but never 401, 403 or a crash.
            if (res.status === 401 || res.status === 403 || res.status >= 500)
              bad.push(
                `${r.label} as ${role}: expected through, got ${res.status}`,
              );
          } else {
            deniedCalls++;
            if (res.status !== 403)
              bad.push(
                `${r.label} as ${role}: expected 403, got ${res.status}`,
              );
            else if (
              ![
                'PLATFORM_PERMISSION_REQUIRED',
                'SUPER_ADMIN_REQUIRED',
              ].includes(res.body?.error?.code)
            )
              bad.push(
                `${r.label} as ${role}: wrong 403 code ${res.body?.error?.code}`,
              );
          }
        }
      }
      expect(bad).toEqual([]);
      expect(allowedCalls).toBeGreaterThan(100);
      expect(deniedCalls).toBeGreaterThan(60);
      // The empty requests created nothing.
      expect(
        (
          await t.db.asOwner((pg) =>
            pg.query('select count(*)::int as n from tenants'),
          )
        ).rows[0],
      ).toEqual(tenantsBefore);
      expect(
        (
          await t.db.asOwner((pg) =>
            pg.query('select count(*)::int as n from plans'),
          )
        ).rows[0],
      ).toEqual(plansBefore);
    });
  });

  describe('a suspended organization', () => {
    it('is refused on every tenant route, public and private, with nothing leaking', async () => {
      const sup = await as(t, w.superAdmin);
      const ownerA = await token(w.alice, w.tenantA);
      const ownerB = await token(w.bob, w.tenantB);
      const tenantRoutes = routes.filter(
        (r) => r.orgScoped && !r.platform && !r.isPublic,
      );
      const publicStore = routes.filter(
        (r) =>
          r.isPublic &&
          r.method === 'get' &&
          /\/public\/(storefronts|stores)\//.test(r.path),
      );
      expect(tenantRoutes.length).toBeGreaterThan(150);
      expect(publicStore.length).toBeGreaterThan(5);

      // Control: the same sweep against an ACTIVE organization gets real answers, so the check below is not passing for a trivial reason.
      let ok = 0;
      for (const r of tenantRoutes.filter(
        (x) => x.method === 'get' && !x.path.includes(UUID),
      ))
        if (
          (await call(r, ownerB, { 'X-Organization-Id': w.tenantB })).status ===
          200
        )
          ok++;
      expect(ok).toBeGreaterThan(10);
      let publicOk = 0;
      for (const r of publicStore) {
        const res = await call(
          { ...r, path: r.path.replace(UUID, 'beta-shop') },
          null,
        );
        if (res.status === 200) publicOk++;
      }
      expect(publicOk).toBeGreaterThan(0);

      await sup
        .patch(`/platform/organizations/${w.tenantA}/status`, {
          status: 'suspended',
        })
        .expect(200);

      const bad: string[] = [];
      for (const r of tenantRoutes) {
        const res = await call(r, ownerA, { 'X-Organization-Id': w.tenantA });
        if (res.status !== 403 && res.status !== 404)
          bad.push(`${r.label} -> ${res.status}`);
      }
      for (const r of publicStore) {
        const res = await call(
          { ...r, path: r.path.replace(UUID, 'alpha-shop') },
          null,
        );
        if (res.status === 200) bad.push(`${r.label} (public) -> 200`);
      }
      expect(bad).toEqual([]);

      await sup
        .patch(`/platform/organizations/${w.tenantA}/status`, {
          status: 'active',
        })
        .expect(200);
      expect(
        (
          await call(
            routes.find((r) => r.label === 'GET /api/v1/entitlements')!,
            ownerA,
            { 'X-Organization-Id': w.tenantA },
          )
        ).status,
      ).toBe(200);
    });
  });

  describe('what platform responses contain', () => {
    it('never includes a key, a secret, a token or a password, in any list the platform admin can open', async () => {
      const sup = await token(w.superAdmin);
      const lists = platform.filter(
        (r) =>
          r.method === 'get' &&
          !r.path.includes(UUID) &&
          !r.path.endsWith('/download'),
      );
      expect(lists.length).toBeGreaterThan(15);
      const secrets = [
        SECRETS.RAZORPAY_PLATFORM_KEY_SECRET,
        SECRETS.RAZORPAY_PLATFORM_WEBHOOK_SECRET,
        SECRETS.RAZORPAY_PLATFORM_KEY_ID,
        SECRETS.CRON_SECRET,
        TEST_ENV.SUPABASE_ANON_KEY,
        TEST_ENV.SUPABASE_SERVICE_ROLE_KEY,
        TEST_ENV.AUTH_BFF_SECRET,
        'test-password',
        sup,
      ];
      const keyNames: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, path));
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) {
            if (
              /(password|secret|token|api_?key|authorization|credential|cookie)/i.test(
                k,
              )
            )
              keyNames.push(`${path}.${k}`);
            walk(x, `${path}.${k}`);
          }
      };
      const bad: string[] = [];
      for (const r of lists) {
        const res = await call(r, sup);
        if (res.status !== 200) {
          bad.push(`${r.label} -> ${res.status}`);
          continue;
        }
        const text = JSON.stringify(res.body);
        for (const s of secrets)
          if (text.includes(s)) bad.push(`${r.label} contains a secret`);
        if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\./.test(text))
          bad.push(`${r.label} contains a token`);
        walk(res.body, r.label);
      }
      expect(bad).toEqual([]);
      expect(keyNames).toEqual([]);
    });
  });
});
