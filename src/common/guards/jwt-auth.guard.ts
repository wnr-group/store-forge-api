import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '../../config/configuration.js';
import { SupabaseJwtService } from '../../modules/auth/supabase-jwt.service.js';
import {
  readSessionCookie,
  sessionCookieName,
} from '../../modules/auth/session-cookies.js';
import { AppException } from '../app.exception.js';
import { IS_PUBLIC } from '../decorators/decorators.js';
import type { AuthenticatedRequest } from '../interfaces/request-context.js';

/**
 * Global guard: every route needs a valid Supabase access token unless it is marked `@Public()`.
 *
 * The token comes from the `Authorization: Bearer` header (API clients, Swagger) or, when there is no such header, from
 * the HttpOnly session cookie set by `POST /auth/login` (browsers). A bearer header that is present but invalid is
 * never "rescued" by a cookie. Either way the token is verified against Supabase's signing keys on every request, and
 * roles and permissions are still read from the database, never from the token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly cookieName: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: SupabaseJwtService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.cookieName = sessionCookieName(
      config.get('supabase', { infer: true }).url,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const [scheme, bearer] =
      typeof header === 'string' ? header.split(' ') : [];

    let token: string | undefined;
    let via: 'bearer' | 'cookie' = 'bearer';
    if (scheme?.toLowerCase() === 'bearer' && bearer) {
      token = bearer;
    } else if (!header) {
      const session = await readSessionCookie(
        request.headers.cookie,
        this.cookieName,
      );
      if (session) {
        token = session.accessToken;
        via = 'cookie';
      }
    }
    if (!token) {
      throw new AppException('UNAUTHENTICATED', 'Authentication required.', {
        code: 'AUTH_REQUIRED',
      });
    }

    const identity = await this.jwt.verify(token);
    request.user = {
      id: identity.id,
      email: identity.email,
      token,
      expiresAt: identity.expiresAt,
      fullName: identity.fullName,
    };
    request.authVia = via;
    return true;
  }
}
