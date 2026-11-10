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
    summary: 'Read platform settings',
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
      'Partial update; the audit entry lists only what changed. Rate limit: 20 per 10 minutes.',
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
