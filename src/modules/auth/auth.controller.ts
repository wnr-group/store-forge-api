import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CsrfProtected,
  CurrentUser,
  Public,
} from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import {
  ChangePasswordDto,
  LoginDto,
  LoginResponseDto,
  MeDto,
  SessionDto,
  SignedOutDto,
} from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @Public()
  @CsrfProtected()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @ApiEndpoint({
    summary: 'Sign in (existing accounts only)',
    description: [
      'Checks the credentials with Supabase Auth and sets the session in **HttpOnly** cookies (`sb-<project>-auth-token`, `SameSite=Lax`, `Secure` outside local development) plus a non-secret `sf_signed_in` marker. The tokens are never in the response body.',
      'Returns the safe profile with the existing role and organization memberships. There is **no sign-up**: unknown e-mails fail exactly like wrong passwords, and no account or organization is ever created.',
      'Each attempt is counted against the database login rate limit BEFORE the password is checked. Requires an allowed `Origin` (browsers) or the trusted frontend server secret.',
    ].join('\n\n'),
    auth: 'public',
    body: LoginDto,
    response: LoginResponseDto,
    message: 'Signed in successfully',
    errors: [400, 401, 403, 429],
  })
  login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDto,
  ) {
    return this.sessions.login(req, res, dto);
  }

  @Post('logout')
  @Public()
  @CsrfProtected()
  @HttpCode(200)
  @ApiEndpoint({
    summary: 'Sign out',
    description:
      'Revokes the session at Supabase (best effort) and always clears the session cookies. Safe to call when already signed out.',
    auth: 'public',
    response: SignedOutDto,
    message: 'Signed out successfully',
    errors: [403],
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.logout(req, res);
    return { signedOut: true };
  }

  @Post('refresh')
  @Public()
  @CsrfProtected()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @ApiEndpoint({
    summary: 'Refresh the session',
    description:
      'Exchanges the refresh token in the cookie for a new session. The refresh token is **rotated** by Supabase: the old one stops working. A missing, used or revoked refresh token clears the cookies and answers 401 `SESSION_EXPIRED`.',
    auth: 'public',
    response: SessionDto,
    message: 'Session refreshed successfully',
    errors: [401, 403, 429],
  })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.sessions.refresh(req, res);
  }

  @Get('session')
  @ApiEndpoint({
    summary: 'Verify the current session',
    description:
      "Verifies the access token (Bearer header or the session cookie) against Supabase's signing keys and returns who it belongs to. Read-only: it never refreshes (call `POST /auth/refresh` on `401 TOKEN_EXPIRED`). No database access.",
    auth: 'jwt',
    response: SessionDto,
    message: 'Session is valid',
  })
  session(@CurrentUser() user: AuthUser) {
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName ?? null,
      },
      expiresAt: user.expiresAt ?? null,
    };
  }

  @Get('me')
  @ApiEndpoint({
    summary: 'Current identity (session restoration)',
    description:
      'Returns the verified Supabase user, their display name, their Platform Admin level (if any) and their active organization memberships. Everything except `id`/`email` is read from the database, never from the token. Works with the Bearer header or the session cookie.',
    auth: 'jwt',
    response: MeDto,
    message: 'Profile retrieved successfully',
  })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @Post('change-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiEndpoint({
    summary: 'Change own password',
    description:
      'Re-verifies the current password with Supabase Auth, then sets the new one. Works with the Bearer header or the session cookie.',
    auth: 'jwt',
    body: ChangePasswordDto,
    response: null,
    message: 'Password changed successfully',
    errors: [400, 429],
  })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(user, dto);
  }
}
