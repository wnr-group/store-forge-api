import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServerClient } from '@supabase/ssr';
import type { Request, Response } from 'express';
import { AppException } from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import { NodeEnv } from '../../config/env.validation.js';
import type { LoginDto, LoginResponseDto, SessionDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { LoginRateLimitService } from './login-rate-limit.service.js';
import { clientAddress, isTrustedServer } from './request-trust.js';
import {
  CookieJar,
  parseCookies,
  readSessionCookie,
  sessionCookieName,
  type WrittenCookie,
} from './session-cookies.js';

type AuthError = { code?: string; status?: number; message?: string };

const INVALID = 'Incorrect email or password.';

/**
 * The browser session, handled here instead of in the Next.js app: Supabase Auth checks the credentials and rotates
 * the refresh token; this service only turns the result into hardened HttpOnly cookies (same cookie the Next.js app
 * has always read) and back. It issues no tokens of its own and stores no passwords.
 *
 * Behaviour is the Next.js behaviour moved over: password sign-in for existing accounts only (no sign-up, no
 * automatic account or organization creation, no extra roles), the same error messages, sign-out that revokes the
 * session at Supabase, and the login attempt counted before the password is checked.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly cookieName: string;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly auth: AuthService,
    private readonly rateLimit: LoginRateLimitService,
  ) {
    this.cookieName = sessionCookieName(
      this.config.get('supabase', { infer: true }).url,
    );
  }

  private secure(req: Request): boolean {
    return (
      this.config.get('env', { infer: true }) === NodeEnv.Production ||
      req.secure
    );
  }

  /** A supabase-js client whose session storage is this request's cookies; what it writes is collected in `jar`. */
  private client(
    req: Request,
    jar: CookieJar,
    options: { ignoreSession?: boolean } = {},
  ) {
    const { url, anonKey } = this.config.get('supabase', { infer: true });
    return createServerClient(url, anonKey, {
      cookies: {
        // `ignoreSession`: present the request WITHOUT the stored session. supabase-js would otherwise load it first and
        // silently refresh an expired one, spending the refresh token before our explicit refresh uses it.
        getAll: () =>
          parseCookies(req.headers.cookie).filter(
            (c) =>
              !options.ignoreSession ||
              !(
                c.name === this.cookieName ||
                c.name.startsWith(`${this.cookieName}.`)
              ),
          ),
        setAll: (cookies) => jar.setAll(cookies as WrittenCookie[]),
      },
    });
  }

  private send(res: Response, jar: CookieJar) {
    res.setHeader('Cache-Control', 'no-store');
    if (jar.headers.length) res.append('Set-Cookie', jar.headers);
  }

  private mapSignInError(error: AuthError): AppException {
    if (error.code === 'invalid_credentials')
      return new AppException('UNAUTHENTICATED', INVALID, {
        code: 'INVALID_CREDENTIALS',
      });
    // Provisioned accounts are created confirmed; this only happens if one was created some other way.
    if (error.code === 'email_not_confirmed')
      return new AppException(
        'UNAUTHENTICATED',
        'This account is not active yet. Please contact your administrator.',
        { code: 'ACCOUNT_NOT_ACTIVE' },
      );
    if (error.status === 429 || error.code === 'over_request_rate_limit')
      return new AppException(
        'RATE_LIMITED',
        'Too many attempts. Please wait a moment and try again.',
      );
    this.logger.error(`sign-in failed: ${error.code ?? error.status}`);
    return new AppException(
      'UNKNOWN',
      'Something went wrong. Please try again.',
    );
  }

  /** Signs an EXISTING account in and sets the session cookies. Nothing is created, on failure nothing is set. */
  async login(
    req: Request,
    res: Response,
    dto: LoginDto,
  ): Promise<LoginResponseDto> {
    const trusted = isTrustedServer(
      req,
      this.config.get('auth', { infer: true }).bffSecret,
    );
    await this.rateLimit.enforce(clientAddress(req, trusted), dto.email);

    const jar = new CookieJar(this.secure(req), this.cookieName);
    const { data, error } = await this.client(req, jar).auth.signInWithPassword(
      {
        email: dto.email,
        password: dto.password,
      },
    );
    if (error || !data.session || !data.user) {
      throw this.mapSignInError(error ?? { message: 'no session returned' });
    }

    const profile = await this.auth.me({
      id: data.user.id,
      email: data.user.email ?? null,
      token: data.session.access_token,
    });
    this.send(res, jar);
    return Object.assign(profile, {
      expiresAt: data.session.expires_at ?? null,
    });
  }

  /** Revokes the session at Supabase (best effort) and ALWAYS clears the cookies. */
  async logout(req: Request, res: Response): Promise<void> {
    const jar = new CookieJar(this.secure(req), this.cookieName);
    try {
      if (await readSessionCookie(req.headers.cookie, this.cookieName))
        await this.client(req, jar).auth.signOut();
    } catch (error) {
      // The user still ends up signed out locally; the session simply expires at Supabase on its own.
      this.logger.warn(
        `sign-out could not revoke the session: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    jar.clearSession(parseCookies(req.headers.cookie));
    this.send(res, jar);
  }

  /**
   * Exchanges the refresh token for a new session (the refresh token is rotated: the old one stops working). A refresh
   * token that is missing, used or revoked ends the session: cookies are cleared and the answer is 401.
   */
  async refresh(req: Request, res: Response): Promise<SessionDto> {
    const jar = new CookieJar(this.secure(req), this.cookieName);
    const stored = await readSessionCookie(req.headers.cookie, this.cookieName);
    if (!stored?.refreshToken) return this.endSession(req, res, jar);

    const { data, error } = await this.client(req, jar, {
      ignoreSession: true,
    }).auth.refreshSession({ refresh_token: stored.refreshToken });
    if (error || !data.session || !data.user) {
      if (
        error &&
        (error.status === 429 || error.code === 'over_request_rate_limit')
      )
        throw this.mapSignInError(error);
      return this.endSession(req, res, jar);
    }
    jar.clearStaleChunks(parseCookies(req.headers.cookie), jar.writtenNames);
    this.send(res, jar);
    return {
      user: { id: data.user.id, email: data.user.email ?? null },
      expiresAt: data.session.expires_at ?? null,
    };
  }

  private endSession(req: Request, res: Response, jar: CookieJar): never {
    jar.clearSession(parseCookies(req.headers.cookie));
    this.send(res, jar);
    throw new AppException(
      'UNAUTHENTICATED',
      'Your session has expired. Please sign in again.',
      { code: 'SESSION_EXPIRED' },
    );
  }
}
