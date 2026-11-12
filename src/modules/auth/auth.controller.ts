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
    summary: 'Sign in',
    description: [
      'Sign in with an email and password. Your login details are checked with Supabase Auth, and your session is saved in secure cookies (`sb-<project>-auth-token`, `SameSite=Lax`, and `Secure` everywhere except local development). The cookies are HttpOnly, so scripts running in the browser cannot read them. A second, harmless cookie called `sf_signed_in` just tells the app that you are signed in. Your tokens are never included in the response body.',
      'The response is your basic profile, your role and the organizations you belong to. This call can only sign in existing accounts. It never creates one. An unknown email gets exactly the same error as a wrong password, so nobody can use it to find out which emails are registered.',
      'Every attempt is counted towards the login limit before the password is checked, so repeated guessing gets blocked. Browsers must call this from an allowed website address (`Origin`), and the Next.js server must send its trusted secret.',
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
      'Sign out of your account. The session is cancelled at Supabase (if that step fails, sign-out still goes ahead) and your session cookies are always removed. It is safe to call even if you are already signed out.',
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
    summary: 'Keep the session alive',
    description:
      'Get a fresh session without asking the user to sign in again. It uses the refresh token stored in your cookie. Each refresh token works only once: Supabase gives you a new one and the old one stops working. If the token is missing, was already used, or was cancelled, your cookies are cleared and you get a 401 error with the code `SESSION_EXPIRED`.',
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
    summary: 'Check if you are signed in',
    description:
      'Find out whether your access token is still valid and who it belongs to. The token can be sent in the Bearer header or come from the session cookie, and it is checked against the Supabase signing keys. This call only checks. It never renews the session, so if you get `401 TOKEN_EXPIRED`, call `POST /auth/refresh` to renew it. It does not read from the database.',
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
    summary: 'Get my account details',
    description:
      'Get everything the app needs to know about the signed-in person: their id and email, display name, Platform Admin level (if they have one) and the organizations they are an active member of. Apart from `id` and `email`, all of this is read from the database and never trusted from the token. The token can be sent in the Bearer header or come from the session cookie. The app uses this to restore your session when the page reloads.',
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
    summary: 'Change my password',
    description:
      'Set a new password for your own account. You must first enter your current password, which is checked with Supabase Auth, and only then is the new one saved. The token can be sent in the Bearer header or come from the session cookie.',
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
