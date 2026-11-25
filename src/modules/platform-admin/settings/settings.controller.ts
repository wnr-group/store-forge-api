import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  LogoUploadRequestDto,
  LogoUploadTargetDto,
  PlatformSettingsDto,
  SetLogoDto,
  UpdatePlatformSettingsDto,
} from './settings.dto.js';
import { PlatformSettingsService } from './settings.service.js';

@ApiTags('platform-admin')
@Controller('platform/settings')
@PlatformAccess()
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @PlatformAccess({ permission: 'settings:read' })
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

  @Post('logo/upload-url')
  @PlatformAccess({ level: 'super_admin', bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Get a link to upload the platform logo',
    description:
      'Ask for a one-time upload link for the platform logo (a JPEG, PNG or WebP image of at most 2 MB). Upload the file to the link with a PUT request, then call `PUT /platform/settings/logo` with the returned `path` to start using it.',
    auth: 'super_admin',
    permission: 'super admin',
    body: LogoUploadRequestDto,
    response: LogoUploadTargetDto,
    status: 201,
    message: 'Upload URL created successfully',
  })
  uploadUrl(@CurrentUser() admin: AuthUser, @Body() dto: LogoUploadRequestDto) {
    return this.settings.uploadTarget(admin.token, dto);
  }

  @Put('logo')
  @PlatformAccess({ level: 'super_admin', bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Set the platform logo',
    description:
      'Use an uploaded file as the platform logo. It then appears on the sign-in page, the public site and the dashboards. The previous logo file is deleted. The change is recorded in the activity log.',
    auth: 'super_admin',
    permission: 'super admin',
    body: SetLogoDto,
    response: PlatformSettingsDto,
    message: 'Platform logo updated successfully',
  })
  setLogo(@CurrentUser() admin: AuthUser, @Body() dto: SetLogoDto) {
    return this.settings.setLogo(admin.id, admin.token, dto.path);
  }

  @Delete('logo')
  @PlatformAccess({ level: 'super_admin', bucket: 'settings.update' })
  @ApiEndpoint({
    summary: 'Remove the platform logo',
    description:
      'Go back to the built-in StoreForge logo. The uploaded file is deleted. The change is recorded in the activity log.',
    auth: 'super_admin',
    permission: 'super admin',
    response: PlatformSettingsDto,
    message: 'Platform logo removed successfully',
  })
  removeLogo(@CurrentUser() admin: AuthUser) {
    return this.settings.setLogo(admin.id, admin.token, null);
  }
}
