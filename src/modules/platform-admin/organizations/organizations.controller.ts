import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentPlatformLevel,
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type {
  AuthUser,
  PlatformLevel,
} from '../../../common/interfaces/request-context.js';
import {
  CreatedMemberDto,
  CreateMemberDto,
  MemberStatusDto,
  TeamMemberDto,
} from '../../team/team.dto.js';
import {
  CompanyDetailDto,
  CompanyDto,
  CreatedCompanyDto,
  CreateOrganizationDto,
  OrganizationStatusDto,
  OrgListQueryDto,
  PlatformOverviewDto,
  PlatformStoreDto,
  RecoveredOwnerDto,
  RecoverOwnerDto,
  TransferOwnershipDto,
  UpdateOrganizationDto,
  UpdateOrganizationStoreDto,
} from './organizations.dto.js';
import { PlatformOrganizationsService } from './organizations.service.js';

class PlatformMeDto {
  @ApiProperty({ enum: ['super_admin', 'admin'] }) level!: string;
}

const ID = {
  name: 'id',
  format: 'uuid',
  description: 'Organization id',
} as const;

@ApiTags('platform-admin')
@Controller('platform')
@PlatformAccess()
export class PlatformOrganizationsController {
  constructor(private readonly orgs: PlatformOrganizationsService) {}

  @Get('me')
  @ApiEndpoint({
    summary: 'My Platform Admin level',
    description:
      'Answered by the database (`platform_admin_role()`). Non-admins get 403.',
    auth: 'platform',
    response: PlatformMeDto,
    message: 'Platform admin level retrieved successfully',
  })
  me(@CurrentPlatformLevel() level: PlatformLevel) {
    return { level };
  }

  @Get('overview')
  @ApiEndpoint({
    summary: 'Platform overview',
    description:
      'Organization and user totals plus the five newest organizations.',
    auth: 'platform',
    response: PlatformOverviewDto,
    message: 'Overview retrieved successfully',
  })
  overview(@CurrentUser() admin: AuthUser) {
    return this.orgs.overview(admin.id);
  }

  @Get('organizations')
  @ApiEndpoint({
    summary: 'List organizations',
    description:
      'Search (name / slug), status filter, sorting and paging all run in PostgreSQL. A page past the end returns the last real page.',
    auth: 'platform',
    response: [CompanyDto],
    paginated: true,
    message: 'Organizations retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser, @Query() query: OrgListQueryDto) {
    return this.orgs.list(admin.id, query);
  }

  @Post('organizations')
  @PlatformAccess({ bucket: 'org.create' })
  @ApiEndpoint({
    summary: 'Create an organization and its Owner',
    description:
      'Creates a confirmed Supabase account for the Owner (no email verification), then the organization, its store and the owner membership in one transaction. Idempotent for the same owner and store address; the Auth account is removed again if provisioning fails. Rate limit: 10 per 10 minutes per admin.',
    auth: 'platform',
    permission: 'any Platform Admin',
    body: CreateOrganizationDto,
    response: CreatedCompanyDto,
    status: 201,
    message: 'Organization created successfully',
    errors: [409],
  })
  create(@CurrentUser() admin: AuthUser, @Body() dto: CreateOrganizationDto) {
    return this.orgs.create(admin.id, dto);
  }

  @Get('organizations/:id')
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Organization detail',
    description:
      'The organization, its primary store and its team. Never catalog, customer or order data.',
    auth: 'platform',
    response: CompanyDetailDto,
    message: 'Organization retrieved successfully',
    errors: [404],
  })
  get(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orgs.get(admin.id, id);
  }

  @Patch('organizations/:id')
  @PlatformAccess({ bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Edit an organization',
    description:
      'Partial update of name, contact phone and address. Nothing is written or logged when nothing changed. Rate limit: 60 per 10 minutes.',
    auth: 'platform',
    body: UpdateOrganizationDto,
    response: CompanyDto,
    message: 'Organization updated successfully',
    errors: [404],
  })
  update(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.orgs.update(admin.id, id, dto);
  }

  @Delete('organizations/:id')
  @PlatformAccess({ bucket: 'org.delete' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Delete an organization permanently',
    description:
      'Deletes the organization and everything under it in one transaction, then (best effort) the sign-ins of people who belonged to no other organization and its stored files. Rate limit: 5 per 10 minutes.',
    auth: 'platform',
    response: null,
    message: 'Organization deleted successfully',
    errors: [404],
  })
  async remove(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.orgs.remove(admin.id, admin.token, id);
  }

  @Patch('organizations/:id/status')
  @PlatformAccess({ bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Suspend or reactivate an organization',
    description:
      'A suspended organization is invisible to all of its members at the database level.',
    auth: 'platform',
    body: OrganizationStatusDto,
    response: CompanyDto,
    message: 'Organization status updated successfully',
    errors: [404],
  })
  setStatus(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OrganizationStatusDto,
  ) {
    return this.orgs.setStatus(admin.id, id, dto.status);
  }

  @Patch('organizations/:id/store')
  @PlatformAccess({ bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Edit the primary store',
    description:
      'Name, description, contacts, currency and timezone (never the address or logo). The currency is locked once the store has products or orders.',
    auth: 'platform',
    body: UpdateOrganizationStoreDto,
    response: PlatformStoreDto,
    message: 'Store updated successfully',
    errors: [404],
  })
  updateStore(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganizationStoreDto,
  ) {
    return this.orgs.updateStore(admin.id, id, dto);
  }

  @Post('organizations/:id/members')
  @PlatformAccess({ bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Add a team member to an organization',
    description:
      'Same account an Owner can create; the Owner role cannot be assigned. The Auth account is removed again if linking fails.',
    auth: 'platform',
    body: CreateMemberDto,
    response: CreatedMemberDto,
    status: 201,
    message: 'Team member added successfully',
    errors: [404, 409],
  })
  addMember(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMemberDto,
  ) {
    return this.orgs.addMember(admin.id, id, dto);
  }

  @Patch('organizations/:id/members/:userId/status')
  @PlatformAccess({ bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Disable or reactivate a team member',
    description: 'The Owner cannot be disabled; transfer ownership first.',
    auth: 'platform',
    body: MemberStatusDto,
    response: TeamMemberDto,
    message: 'Team member status updated successfully',
    errors: [404],
  })
  setMemberStatus(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: MemberStatusDto,
  ) {
    return this.orgs.setMemberStatus(admin.id, id, userId, dto.status);
  }

  @Delete('organizations/:id/members/:userId')
  @PlatformAccess({ bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a team member',
    description:
      'The Owner cannot be removed. The sign-in is deleted too when the person belongs to no other organization.',
    auth: 'platform',
    response: null,
    message: 'Team member removed successfully',
    errors: [404],
  })
  async removeMember(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.orgs.removeMember(admin.id, id, userId);
  }

  @Post('organizations/:id/ownership/transfer')
  @PlatformAccess({ bucket: 'ownership.change' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Transfer ownership to an existing member',
    description:
      'The target must be an active team member. Atomic: the old owner becomes a team member (kept or disabled), so there are never zero or two owners. Rate limit: 5 per 10 minutes.',
    auth: 'platform',
    body: TransferOwnershipDto,
    response: CompanyDetailDto,

    message: 'Ownership transferred successfully',
    errors: [404],
  })
  transfer(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.orgs.transferOwnership(admin.id, id, dto);
  }

  @Post('organizations/:id/ownership/recover')
  @PlatformAccess({ bucket: 'ownership.change' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Recover ownership with a new account',
    description:
      'For an organization whose owner is lost or missing: creates a brand-new confirmed account and makes it the owner.',
    auth: 'platform',
    body: RecoverOwnerDto,
    response: RecoveredOwnerDto,
    status: 201,
    message: 'Ownership recovered successfully',
    errors: [404, 409],
  })
  recover(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecoverOwnerDto,
  ) {
    return this.orgs.recoverOwner(admin.id, id, dto);
  }
}
