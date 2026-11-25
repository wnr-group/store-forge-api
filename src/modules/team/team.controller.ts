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
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
  RequireFeature,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreatedMemberDto,
  CreateMemberDto,
  MemberStatusDto,
  ResetPasswordDto,
  TeamMemberDto,
  UpdateMemberDto,
} from './team.dto.js';
import { TeamService } from './team.service.js';

const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('team')
@Controller('team/members')
@OrgScoped()
@RequirePermission('members:manage')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @ApiEndpoint({
    summary: 'List team members',
    description:
      'See everyone on your team: the Owner and all the other members. For each person you can see which parts of the store (modules) they are allowed to use.',
    auth: 'org',
    permission: 'members:manage (Owner only)',
    response: [TeamMemberDto],
    message: 'Team members retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.team.list(org);
  }

  @Post()
  @RequireFeature('multiple_staff')
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Add a team member',
    description:
      'Create an account for a new team member and add them to your organization with the access you choose. The account is ready to use straight away, with no email verification step. You cannot make someone an Owner here. If adding them to the organization fails, the new account is deleted again, so no half-finished account is left behind.',
    auth: 'org',
    permission: 'members:manage (Owner only)',
    body: CreateMemberDto,
    response: CreatedMemberDto,
    status: 201,
    message: 'Team member created successfully',
    errors: [409, 429],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateMemberDto) {
    return this.team.create(org, dto);
  }

  @Patch(':userId')
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Edit a team member',
    description:
      "Change a team member's name, the parts of the store they can use, or both. Send only what you want to change. You cannot use this to edit the Owner or yourself.",
    auth: 'org',
    permission: 'members:manage (Owner only)',
    body: UpdateMemberDto,
    response: TeamMemberDto,
    message: 'Team member updated successfully',
    errors: [404],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.team.update(org, userId, dto);
  }

  @Patch(':userId/status')
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Disable or re-enable a team member',
    description:
      "Switch a team member's access off or back on. A disabled member keeps their account but cannot get into your store at all, and you can turn their access back on at any time. You cannot use this on the Owner or yourself.",
    auth: 'org',
    permission: 'members:manage (Owner only)',
    body: MemberStatusDto,
    response: TeamMemberDto,
    message: 'Team member status updated successfully',
    errors: [404],
  })
  setStatus(
    @CurrentOrg() org: OrgContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: MemberStatusDto,
  ) {
    return this.team.setStatus(org, userId, dto.status);
  }

  @Delete(':userId')
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a team member',
    description:
      'Take a person off your team. They lose access to your organization. If they do not belong to any other organization, their sign-in account is deleted as well.',
    auth: 'org',
    permission: 'members:manage (Owner only)',
    response: null,
    message: 'Team member removed successfully',
    errors: [404],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.team.remove(org, userId);
  }

  @Post(':userId/password')
  @Throttle(SENSITIVE)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Reset a team member password',
    description:
      'Set a new password for one of your team members, for example when they forgot theirs. This works only for members of your own team, not for the Owner. Remember to share the new password with them in a safe way.',
    auth: 'org',
    permission: 'members:manage (Owner only)',
    body: ResetPasswordDto,
    response: null,
    message: 'Password reset successfully',
    errors: [404, 429],
  })
  async resetPassword(
    @CurrentOrg() org: OrgContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ResetPasswordDto,
  ) {
    await this.team.resetPassword(org, userId, dto.password);
  }
}
