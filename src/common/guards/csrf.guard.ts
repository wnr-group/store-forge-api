import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../app.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import { CSRF_PROTECTED } from '../decorators/decorators.js';
import {
  isAllowedOrigin,
  isTrustedServer,
} from '../../modules/auth/request-trust.js';
import {
  parseCookies,
  sessionCookieName,
} from '../../modules/auth/session-cookies.js';

export type CsrfVerdict = 'allow' | 'wrong-origin' | 'origin-required';

export interface CsrfInput {
  method: string;
  /** The route signs in / out / refreshes the cookie session, so it is protected even without a cookie. */
  protectedRoute: boolean;
  hasBearer: boolean;
  hasSessionCookie: boolean;
  /** The Origin header, if the browser sent one. */
  origin: string | undefined;
  originAllowed: boolean;
  /** The request carries the shared secret of the trusted frontend server. */
  trustedServer: boolean;
}

/**
 * CSRF rules for the cookie session (pure, so it can be tested exhaustively).
 *
 * A browser attaches cookies to cross-site requests on its own, but it always states where the request came from
 * (`Origin`) on state-changing requests and a page on another site cannot forge it. So a state-changing request that
 * could be riding on the cookie session must come from an allowed origin, or from the trusted frontend server, which
 * proves itself with the shared secret and has no Origin. `SameSite=Lax` on the cookie is the second layer.
 * Bearer-token requests are exempt: a browser never attaches an Authorization header by itself.
 */
export function evaluateCsrf(i: CsrfInput): CsrfVerdict {
  if (['GET', 'HEAD', 'OPTIONS'].includes(i.method.toUpperCase()))
    return 'allow';
  if (!i.protectedRoute) {
    if (i.hasBearer) return 'allow';
    if (!i.hasSessionCookie) return 'allow'; // no cookie session to ride on
  }
  if (i.origin !== undefined) return i.originAllowed ? 'allow' : 'wrong-origin';
  return i.trustedServer ? 'allow' : 'origin-required';
}

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly cookieName: string;
  private readonly origins: string[];
  private readonly secret: string | undefined;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService<AppConfig, true>,
  ) {
    this.cookieName = sessionCookieName(
      config.get('supabase', { infer: true }).url,
    );
    this.origins = config.get('corsOrigins', { infer: true });
    this.secret = config.get('auth', { infer: true }).bffSecret;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const originHeader = req.headers.origin;
    const verdict = evaluateCsrf({
      method: req.method,
      protectedRoute:
        this.reflector.getAllAndOverride<boolean>(CSRF_PROTECTED, [
          context.getHandler(),
          context.getClass(),
        ]) === true,
      hasBearer: /^bearer\s+\S+/i.test(req.headers.authorization ?? ''),
      hasSessionCookie: parseCookies(req.headers.cookie).some(
        (c) =>
          c.name === this.cookieName ||
          c.name.startsWith(`${this.cookieName}.`),
      ),
      origin: typeof originHeader === 'string' ? originHeader : undefined,
      originAllowed:
        typeof originHeader === 'string' &&
        isAllowedOrigin(originHeader, this.origins, req),
      trustedServer: isTrustedServer(req, this.secret),
    });
    if (verdict === 'allow') return true;
    throw new AppException(
      'FORBIDDEN',
      verdict === 'wrong-origin'
        ? 'This request came from an origin that is not allowed.'
        : 'This request must come from an allowed origin.',
      {
        code:
          verdict === 'wrong-origin'
            ? 'CSRF_ORIGIN_NOT_ALLOWED'
            : 'CSRF_ORIGIN_REQUIRED',
      },
    );
  }
}
