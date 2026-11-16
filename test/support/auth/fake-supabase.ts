import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type * as jose from 'jose';

export interface FakeSupabaseServer {
  url: string;
  issuer: string;
  jwksUrl: string;
  userCalls: () => number;
  resetUserCalls: () => void;
  jwksCalls: () => number;
  resetJwksCalls: () => void;
  setJwks: (keys: jose.JWK[]) => void;
  setJwksResponse: (status: number, body?: unknown) => void;
  setUserResponse: (
    status: number,
    body?: unknown,
    headers?: Record<string, string>,
  ) => void;
  setDelayMs: (delay: number) => void;
  close: () => Promise<void>;
}

export interface FakeSupabaseOptions {
  keys?: jose.JWK[];
}

export async function createFakeSupabase(
  options: FakeSupabaseOptions = {},
): Promise<FakeSupabaseServer> {
  let jwksKeys: jose.JWK[] = options.keys ?? [];
  let userCallCount = 0;
  let jwksCallCount = 0;
  let customJwksResponse: { status: number; body?: unknown } | undefined;
  let customUserResponse:
    | { status: number; body?: unknown; headers?: Record<string, string> }
    | undefined;
  let delayMs = 0;

  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      // GET /auth/v1/.well-known/jwks.json
      if (
        req.method === 'GET' &&
        pathname === '/auth/v1/.well-known/jwks.json'
      ) {
        jwksCallCount++;
        if (customJwksResponse) {
          res.writeHead(customJwksResponse.status, {
            'Content-Type': 'application/json',
          });
          res.end(
            typeof customJwksResponse.body === 'string'
              ? customJwksResponse.body
              : JSON.stringify(customJwksResponse.body ?? {}),
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: jwksKeys }));
        return;
      }

      // GET /auth/v1/user
      if (req.method === 'GET' && pathname === '/auth/v1/user') {
        userCallCount++;

        if (customUserResponse) {
          res.writeHead(customUserResponse.status, {
            'Content-Type': 'application/json',
            ...customUserResponse.headers,
          });
          res.end(
            typeof customUserResponse.body === 'string'
              ? customUserResponse.body
              : JSON.stringify(customUserResponse.body ?? {}),
          );
          return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }

        const token = authHeader.slice(7);
        try {
          const parts = token.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(
              Buffer.from(parts[1], 'base64url').toString('utf-8'),
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: payload.sub,
                email: payload.email ?? 'test@example.com',
                role: payload.role ?? 'authenticated',
                app_metadata: payload.app_metadata ?? {},
                user_metadata: payload.user_metadata ?? {},
              }),
            );
            return;
          }
        } catch {
          // fall through to generic 401
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Invalid token' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not found' }));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  const issuer = `${url}/auth/v1`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;

  return {
    url,
    issuer,
    jwksUrl,
    userCalls: () => userCallCount,
    resetUserCalls: () => {
      userCallCount = 0;
    },
    jwksCalls: () => jwksCallCount,
    resetJwksCalls: () => {
      jwksCallCount = 0;
    },
    setJwks: (keys: jose.JWK[]) => {
      jwksKeys = keys;
      customJwksResponse = undefined;
    },
    setJwksResponse: (status: number, body?: unknown) => {
      customJwksResponse = { status, body };
    },
    setUserResponse: (
      status: number,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      customUserResponse = { status, body, headers };
    },
    setDelayMs: (delay: number) => {
      delayMs = delay;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
