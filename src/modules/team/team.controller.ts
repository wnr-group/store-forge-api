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
      'The Owner and every member of the organization, with their module access.',
    auth: 'org',
    permission: 'members:manage (Owner only)',
    response: [TeamMemberDto],
    message: 'Team members retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.team.list(org);
  }

  @Post()
  @Throttle(SENSITIVE)
  @ApiEndpoint({
    summary: 'Create a team member',
    description:
      'Creates a confirmed Supabase account (no email verification) and links it to the organization with the given module access. The Owner role cannot be assigned. If linking fails the new account is deleted again.',
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
      'Partial update of name and/or module access. The Owner and yourself cannot be edited here.',
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
      'A disabled member keeps their account but has no access at all. Reversible. The Owner and yourself cannot be changed.',
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
      'Removes the membership. The Supabase account is deleted too when the person belongs to no other organization.',
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
    summary: "Reset a team member's password",
    description:
      'Admin-assisted reset: sets a new password for one of your own non-owner members. Share it securely.',
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
