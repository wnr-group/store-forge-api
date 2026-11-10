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
    summary: 'Read own profile',
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
    summary: 'Update own display name',
    description:
      'Updates `profiles.full_name` (row level security allows only your own row) and the Supabase Auth display name.',
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
