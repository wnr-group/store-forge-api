import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  PlatformSettingsDto,
  UpdatePlatformSettingsDto,
} from './settings.dto.js';
import { PlatformSettingsService } from './settings.service.js';

@ApiTags('platform-admin')
@Controller('platform/settings')
@PlatformAccess()
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'View platform settings',
    description:
      'Get the current platform-wide settings, such as the platform name and support email.',
    auth: 'platform',
    response: PlatformSettingsDto,
    message: 'Platform settings retrieved successfully',
  })
  get(@CurrentUser() admin: AuthUser) {
    return this.settings.get(admin.id);
  }

  @Patch()
  @PlatformAccess({ level: 'super_admin', bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Update platform settings',
    description:
      'Change the platform-wide settings. Send only the fields you want to change. The activity log records only the things that actually changed. To protect against misuse, you can do this at most 20 times in 10 minutes.',
    auth: 'super_admin',
    permission: 'super admin',
    body: UpdatePlatformSettingsDto,
    response: PlatformSettingsDto,
    message: 'Platform settings updated successfully',
  })
  update(
    @CurrentUser() admin: AuthUser,
    @Body() dto: UpdatePlatformSettingsDto,
  ) {
    return this.settings.update(admin.id, dto);
  }
}
