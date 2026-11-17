import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  AddedPlatformAdminDto,
  AddPlatformAdminDto,
  PlatformAdminDto,
  SetPlatformAdminRoleDto,
} from './admins.dto.js';
import { PlatformAdminsService } from './admins.service.js';

@ApiTags('platform-admin')
@Controller('platform/admins')
@PlatformAccess()
export class PlatformAdminsController {
  constructor(private readonly admins: PlatformAdminsService) {}

  @Get()
  @ApiEndpoint({
    summary: 'List Platform Admins',
    description:
      'See all the Platform Admins. Every Platform Admin can view this list, but only super admins can change it.',
    auth: 'platform',
    response: [PlatformAdminDto],
    message: 'Platform admins retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser) {
    return this.admins.list(admin.id);
  }

  @Post()
  @PlatformAccess({ level: 'super_admin', bucket: 'admin.manage' })
  @ApiEndpoint({
    summary: 'Add a Platform Admin',
    description:
      'Create a new account and make it a Platform Admin. The account is ready to use straight away, with no email verification step. A person who already belongs to an organization cannot become a Platform Admin. To protect against misuse, you can do this at most 10 times in 10 minutes.',
    auth: 'super_admin',
    permission: 'super admin',
    body: AddPlatformAdminDto,
    response: AddedPlatformAdminDto,
    status: 201,
    message: 'Platform admin added successfully',
    errors: [409],
  })
  add(@CurrentUser() admin: AuthUser, @Body() dto: AddPlatformAdminDto) {
    return this.admins.add(admin.id, dto);
  }

  @Patch(':userId')
  @PlatformAccess({ level: 'super_admin', bucket: 'admin.manage' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change a Platform Admin level',
    description:
      'Promote or demote a Platform Admin by changing their level. The last remaining super admin can never be demoted. If the level you send is the same as the current one, nothing is changed and nothing is added to the audit log.',
    auth: 'super_admin',
    permission: 'super admin',
    body: SetPlatformAdminRoleDto,
    response: PlatformAdminDto,
    message: 'Platform admin updated successfully',
    errors: [404],
  })
  setRole(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetPlatformAdminRoleDto,
  ) {
    return this.admins.setRole(admin.id, userId, dto.role);
  }

  @Delete(':userId')
  @PlatformAccess({ level: 'super_admin', bucket: 'admin.manage' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a Platform Admin',
    description:
      "Take away someone's Platform Admin access. You can remove yourself too, as long as another super admin remains. The last remaining super admin can never be removed. Afterwards, the person's account is deleted.",
    auth: 'super_admin',
    permission: 'super admin',
    response: null,
    message: 'Platform admin removed successfully',
    errors: [404],
  })
  async remove(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.admins.remove(admin.id, userId);
  }
}
