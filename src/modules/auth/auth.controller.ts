import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { CurrentUser } from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { ChangePasswordDto, MeDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  @ApiEndpoint({
    summary: 'Current identity',
    description:
      'Returns the verified Supabase user, their Platform Admin level (if any) and their active organization memberships. Everything except `id`/`email` is read from the database, never from the token.',
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
      'Re-verifies the current password with Supabase Auth, then sets the new one. Sign-in, sign-out and token refresh are done with the Supabase SDK, not this API.',
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
