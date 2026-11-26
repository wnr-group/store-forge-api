import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Where a request came from. Descriptive only: it is written to audit entries and logs and never decides anything. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const store = new AsyncLocalStorage<RequestMeta>();

/** The metadata of the request being handled, or undefined outside a request (a script, a job started elsewhere). */
export const currentRequestMeta = (): RequestMeta | undefined =>
  store.getStore();

const SAFE_ID = /^[A-Za-z0-9._-]{8,100}$/;

/**
 * Express middleware: records the client address, user agent and a request id for the rest of the request, and returns the id in the
 * `X-Request-Id` header so a support request can quote it. A caller-supplied id is kept only when it looks like an id; anything else is
 * replaced, so a client cannot put arbitrary text into the audit log through this header.
 */
export function requestMetaMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const supplied = req.headers['x-request-id'];
  const requestId =
    typeof supplied === 'string' && SAFE_ID.test(supplied)
      ? supplied
      : randomUUID();
  const ua = req.headers['user-agent'];
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  res.setHeader('X-Request-Id', requestId);
  store.run(
    {
      ip: ip ? ip.slice(0, 64) : null,
      userAgent: typeof ua === 'string' && ua ? ua.slice(0, 300) : null,
      requestId,
    },
    next,
  );
}
