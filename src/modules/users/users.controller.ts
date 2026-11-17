import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { CurrentUser } from '../../common/decorators/decorators.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { ProfileDto, UpdateProfileDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiEndpoint({
    summary: 'View my profile',
    description: 'Get your own profile details, such as your name and email.',
    auth: 'jwt',
    response: ProfileDto,
    message: 'Profile retrieved successfully',
    errors: [404],
  })
  getOwn(@CurrentUser() user: AuthUser) {
    return this.users.getOwn(user);
  }

  @Patch('me')
  @ApiEndpoint({
    summary: 'Change my name',
    description:
      'Change the name shown for your account. It is updated in your profile and in your Supabase sign-in account, and you can only ever change your own.',
    auth: 'jwt',
    body: UpdateProfileDto,
    response: ProfileDto,
    message: 'Profile updated successfully',
    errors: [404],
  })
  updateOwn(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateOwnName(user, dto.fullName);
  }
}
