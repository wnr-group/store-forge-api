import { appendFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { SupabaseAdminService } from '../../src/modules/auth/supabase-admin.service.js';
import { SupabaseJwtService } from '../../src/modules/auth/supabase-jwt.service.js';
import { StorageService } from '../../src/modules/storage/storage.service.js';
import { TEST_ENV } from './test-env.js';
import type { TestDb } from './pglite.js';

const randomIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

export const ISSUER = `${TEST_ENV.SUPABASE_URL}/auth/v1`;

const keys = generateKeyPair('RS256');

/** Signs a Supabase-style access token with the test key (what the real project's Auth server would issue). */
export async function signToken(
  sub: string,
  options: {
    email?: string;
    role?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    extra?: Record<string, unknown>;
    privateKey?: KeyObject | CryptoKey;
  } = {},
) {
  const { privateKey } = await keys;
  return new SignJWT({
    role: options.role ?? 'authenticated',
    email: options.email ?? `${sub}@example.test`,
    ...options.extra,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt(
      typeof options.expiresIn === 'number' && options.expiresIn < 0
        ? Math.floor(Date.now() / 1000) - 3600
        : undefined,
    )
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(options.privateKey ?? privateKey);
}

export async function publicJwk() {
  return exportJWK((await keys).publicKey);
}

/** A key the test verifier does NOT trust, for "bad signature" tests. */
export const otherKeys = generateKeyPair('RS256');

export const keyResolver: JWTVerifyGetKey = async () =>
  (await keys).publicKey as never;

/** In-memory stand-in for Supabase Auth Admin: creates real `auth.users` rows so triggers and FKs behave. */
export class FakeAuthAdmin {
  readonly deleted: string[] = [];
  readonly passwords = new Map<string, string>();
  readonly names = new Map<string, string>();
  failNextCreate = false;

  constructor(private readonly db: TestDb) {}

  async createConfirmedUser(input: {
    email: string;
    password: string;
    fullName: string;
  }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('boom');
    }
    return this.db.asOwner(async (pg) => {
      const existing = await pg.query(
        'select 1 from auth.users where email = $1',
        [input.email],
      );
      if (existing.rows.length) {
        const { AppException } =
          await import('../../src/common/app.exception.js');
        throw new AppException(
          'CONFLICT',
          'An account with this email already exists.',
          { code: 'EMAIL_TAKEN' },
        );
      }
      const res = await pg.query<{ id: string }>(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
        [input.email, JSON.stringify({ full_name: input.fullName })],
      );
      this.passwords.set(res.rows[0].id, input.password);
      return { id: res.rows[0].id, email: input.email };
    });
  }

  async setUserPassword(userId: string, password: string) {
    this.passwords.set(userId, password);
  }

  async setUserFullName(userId: string, fullName: string) {
    this.names.set(userId, fullName);
  }

  async deleteUserQuietly(userId: string) {
    this.deleted.push(userId);
    await this.db.asOwner((pg) =>
      pg.query('delete from auth.users where id = $1', [userId]),
    );
    return true;
  }
}

/** In-memory Supabase Storage. Objects exist only when a test "uploads" them. */
export class FakeStorage {
  readonly objects = new Map<string, { mimeType: string; sizeBytes: number }>();
  readonly removed: string[] = [];

  upload(path: string, mimeType = 'image/png', sizeBytes = 1234) {
    this.objects.set(path, { mimeType, sizeBytes });
  }

  async createUploadTargets(
    _token: string,
    folder: string,
    files: { type: string }[],
  ) {
    return files.map((f, i) => ({
      path: `${folder}/${i}.png`,
      token: `t${i}-${f.type}`,
      signedUrl: `http://storage.test/${folder}/${i}.png`,
    }));
  }

  async verifyObjects(_token: string, folder: string, paths: string[]) {
    const { isDirectChild } =
      await import('../../src/modules/storage/storage-paths.js');
    const { invalid } = await import('../../src/common/app.exception.js');
    return paths.map((path) => {
      if (!isDirectChild(path, folder))
        throw invalid('An uploaded image has an invalid path.');
      const o = this.objects.get(path);
      if (!o)
        throw invalid(
          'An image upload did not finish. Please upload it again.',
        );
      return { path, ...o };
    });
  }

  async removeObjects(_token: string, paths: string[]) {
    for (const p of paths) {
      this.removed.push(p);
      this.objects.delete(p);
    }
  }

  async removeTenantObjects() {
    /* nothing to do in memory */
  }
}

/** Records what the password-change flow asks Supabase Auth to do; no network. */
export class FakeAuthClient {
  readonly calls: string[] = [];
  currentPasswords = new Map<string, string>();
  failSignIn: { code?: string; status?: number } | null = null;
}

export interface TestApp {
  app: INestApplication<App>;
  db: TestDb;
  authAdmin: FakeAuthAdmin;
  storage: FakeStorage;
  authClient: FakeAuthClient;
  close(): Promise<void>;
}

export async function createTestApp(db: TestDb): Promise<TestApp> {
  const authAdmin = new FakeAuthAdmin(db);
  const storage = new FakeStorage();
  const authClient = new FakeAuthClient();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue(db.service)
    .overrideProvider(SupabaseJwtService)
    .useFactory({
      factory: (config: ConfigService) =>
        new SupabaseJwtService(config as never, keyResolver),
      inject: [ConfigService],
    })
    .overrideProvider(SupabaseAdminService)
    .useValue(authAdmin)
    .overrideProvider(StorageService)
    .useValue(storage)
    .overrideProvider(AuthService)
    .useFactory({
      factory: (db: DatabaseService, config: ConfigService) =>
        new (class extends AuthService {
          protected override createAuthClient() {
            return {
              auth: {
                signInWithPassword: async (c: {
                  email: string;
                  password: string;
                }) => {
                  authClient.calls.push(`signIn:${c.email}`);
                  if (authClient.failSignIn)
                    return { error: authClient.failSignIn };
                  return authClient.currentPasswords.get(c.email) === c.password
                    ? { error: null }
                    : { error: { code: 'invalid_credentials' } };
                },
                updateUser: async (a: { password: string }) => {
                  authClient.calls.push(`update:${a.password}`);
                  return { error: null };
                },
                signOut: async () => {
                  authClient.calls.push('signOut');
                  return { error: null };
                },
              },
            } as never;
          }
        })(db, config as never),
      inject: [DatabaseService, ConfigService],
    })
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app); // the same prefix, pipes, filters, headers and CORS as main.ts
  // Rate limits are per client address. Trusting X-Forwarded-For lets each test pick its own "client", so unrelated
  // tests never exhaust each other's budget while the rate-limit tests still use one fixed address.
  (
    app.getHttpAdapter().getInstance() as {
      set: (k: string, v: unknown) => void;
    }
  ).set('trust proxy', true);
  // Optional route-coverage recording (see scripts/route-coverage.ts): which declared routes did the tests really call?
  const hitsFile = process.env.ROUTE_HITS_FILE;
  if (hitsFile) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => {
        const path = (req as Request & { route?: { path: string } }).route
          ?.path;
        if (path)
          appendFileSync(
            hitsFile,
            `${req.method} ${path} ${res.statusCode}
`,
          );
      });
      next();
    });
  }
  await app.init();
  return { app, db, authAdmin, storage, authClient, close: () => app.close() };
}

/** A tiny authenticated client: `as(t, userId, orgId?).get('/products')`. */
export async function as(
  t: TestApp,
  userId: string,
  orgId?: string,
  options: { ip?: string } = {},
) {
  const token = await signToken(userId);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (orgId) headers['X-Organization-Id'] = orgId;
  const http = () => t.app.getHttpServer();
  const withHeaders = (r: request.Test) =>
    r.set({ ...headers, 'X-Forwarded-For': options.ip ?? randomIp() });
  return {
    token,
    get: (url: string) => withHeaders(request(http()).get(`/api/v1${url}`)),
    post: (url: string, body?: object) =>
      withHeaders(request(http()).post(`/api/v1${url}`)).send(body),
    patch: (url: string, body?: object) =>
      withHeaders(request(http()).patch(`/api/v1${url}`)).send(body),
    put: (url: string, body?: object) =>
      withHeaders(request(http()).put(`/api/v1${url}`)).send(body),
    delete: (url: string) =>
      withHeaders(request(http()).delete(`/api/v1${url}`)),
  };
}

export const anonymous = (t: TestApp) => ({
  get: (url: string) => request(t.app.getHttpServer()).get(`/api/v1${url}`),
  post: (url: string, body?: object) =>
    request(t.app.getHttpServer()).post(`/api/v1${url}`).send(body),
});
