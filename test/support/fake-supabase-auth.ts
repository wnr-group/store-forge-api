import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { signToken } from './app.js';
import { TEST_ENV } from './test-env.js';

interface FakeUser {
  id: string;
  email: string;
  password: string;
}

/**
 * A stand-in for the Supabase Auth HTTP API, just enough for supabase-js / @supabase/ssr:
 *   POST /auth/v1/token?grant_type=password        sign in
 *   POST /auth/v1/token?grant_type=refresh_token   rotating refresh (a used token is rejected)
 *   POST /auth/v1/logout                           revokes the user's refresh tokens
 * Tokens are signed with the test key, so the API's real verifier accepts them.
 */
export class FakeSupabaseAuth {
  private server?: Server;
  private readonly users = new Map<string, FakeUser>();
  private readonly refreshTokens = new Map<
    string,
    { userId: string; used: boolean }
  >();
  /** Sign-in attempts that reached Supabase (a rate-limited attempt must NOT show up here). */
  passwordGrants = 0;
  refreshGrants = 0;
  logouts = 0;
  /** Lifetime of newly issued access tokens. */
  accessTtl: string | number = '1h';

  addUser(user: FakeUser) {
    this.users.set(user.email, user);
  }

  async start() {
    const port = Number(new URL(TEST_ENV.SUPABASE_URL).port);
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void this.handle(
          req.method ?? 'GET',
          req.url ?? '/',
          req.headers,
          Buffer.concat(chunks).toString('utf8'),
          res,
        );
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(port, '127.0.0.1', resolve),
    );
  }

  async stop() {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Issues a session for a user directly (used to build cookies in tests). */
  async issue(user: FakeUser) {
    const access_token = await signToken(user.id, {
      email: user.email,
      expiresIn: this.accessTtl,
    });
    const refresh_token = randomBytes(12).toString('hex');
    this.refreshTokens.set(refresh_token, { userId: user.id, used: false });
    const expires_in =
      typeof this.accessTtl === 'number' ? this.accessTtl : 3600;
    return {
      access_token,
      token_type: 'bearer',
      expires_in,
      expires_at: Math.floor(Date.now() / 1000) + expires_in,
      refresh_token,
      user: {
        id: user.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: new Date().toISOString(),
      },
    };
  }

  private async handle(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
    res: import('node:http').ServerResponse,
  ) {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const target = new URL(url, 'http://fake');
    if (headers.apikey !== TEST_ENV.SUPABASE_ANON_KEY)
      return json(401, { message: 'Invalid API key' });

    if (method === 'POST' && target.pathname === '/auth/v1/token') {
      const grant = target.searchParams.get('grant_type');
      const input = JSON.parse(body || '{}') as {
        email?: string;
        password?: string;
        refresh_token?: string;
      };
      if (grant === 'password') {
        this.passwordGrants++;
        const user = this.users.get(String(input.email));
        if (!user || user.password !== input.password)
          return json(400, {
            code: 400,
            error_code: 'invalid_credentials',
            msg: 'Invalid login credentials',
          });
        return json(200, await this.issue(user));
      }
      if (grant === 'refresh_token') {
        this.refreshGrants++;
        const entry = this.refreshTokens.get(String(input.refresh_token));
        if (!entry)
          return json(400, {
            code: 400,
            error_code: 'refresh_token_not_found',
            msg: 'Invalid Refresh Token: Refresh Token Not Found',
          });
        if (entry.used)
          return json(400, {
            code: 400,
            error_code: 'refresh_token_already_used',
            msg: 'Invalid Refresh Token: Already Used',
          });
        entry.used = true;
        const user = [...this.users.values()].find(
          (u) => u.id === entry.userId,
        )!;
        return json(200, await this.issue(user));
      }
    }
    if (method === 'POST' && target.pathname === '/auth/v1/logout') {
      this.logouts++;
      const token = String(headers.authorization ?? '').replace(
        /^Bearer\s+/i,
        '',
      );
      const sub = JSON.parse(
        Buffer.from(token.split('.')[1] ?? 'e30', 'base64url').toString('utf8'),
      ).sub as string | undefined;
      for (const entry of this.refreshTokens.values())
        if (entry.userId === sub) entry.used = true;
      res.writeHead(204);
      return res.end();
    }
    return json(404, { message: `not handled: ${method} ${target.pathname}` });
  }
}
