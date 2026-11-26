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
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { AuditLogDto, AuditQueryDto } from '../audit/audit.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiParam, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentPlatformLevel,
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
} from '../../../common/constants/platform-permissions.js';
import { PLATFORM_ADMIN_ROLES } from '../../../database/schema/enums.js';
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
  @ApiProperty({ enum: PLATFORM_ADMIN_ROLES }) level!: string;
  @ApiProperty({
    type: [String],
    enum: PLATFORM_PERMISSIONS,
    description:
      'What your platform role allows, for showing or hiding screens. The API enforces it either way.',
  })
  permissions!: string[];
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
  constructor(
    private readonly orgs: PlatformOrganizationsService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @PlatformAccess({ anyStaff: true })
  @ApiEndpoint({
    summary: 'Check my Platform Admin level',
    description:
      'Find out whether you are a Platform Admin and at which level (`super_admin`, `admin`, `billing_admin` or `support_admin`) and what that role may do. The answer comes from the database (`platform_admin_role()`). If you are not a Platform Admin, you get a 403 error.',
    auth: 'platform',
    response: PlatformMeDto,
    message: 'Platform admin level retrieved successfully',
  })
  me(@CurrentPlatformLevel() level: PlatformLevel) {
    return { level, permissions: [...PLATFORM_ROLE_PERMISSIONS[level]] };
  }

  @Get('overview')
  @PlatformAccess({ permission: 'tenants:read' })
  @ApiEndpoint({
    summary: 'View the platform overview',
    description:
      'Get a quick summary of the whole platform: how many organizations and users there are, and the five newest organizations.',
    auth: 'platform',
    response: PlatformOverviewDto,
    message: 'Overview retrieved successfully',
  })
  overview(@CurrentUser() admin: AuthUser) {
    return this.orgs.overview(admin.id);
  }

  @Get('organizations')
  @PlatformAccess({ permission: 'tenants:read' })
  @ApiEndpoint({
    summary: 'List organizations',
    description:
      'See all the organizations on the platform, a page at a time. You can search by name, slug (the short web-address name), organization id, public id, the Owner email or the store web address, filter by status and sort the list. All of this is done inside the database, so it stays fast. If you ask for a page beyond the end of the list, you get the last page that actually exists.',
    auth: 'platform',
    response: [CompanyDto],
    paginated: true,
    message: 'Organizations retrieved successfully',
  })
  list(@CurrentUser() admin: AuthUser, @Query() query: OrgListQueryDto) {
    return this.orgs.list(admin.id, query);
  }

  @Get('organizations/:id/activity')
  @PlatformAccess({ permission: 'tenants:read' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: "View an organization's activity history",
    description:
      'See what Platform Admins have done to this organization (created, edited, suspended, team and ownership changes), newest first, a page at a time. It is the activity log narrowed to one organization, and it is still available after the organization is deleted.',
    auth: 'platform',
    response: [AuditLogDto],
    paginated: true,
    message: 'Organization activity retrieved successfully',
  })
  activity(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.audit.list(
      admin.id,
      Object.assign(new AuditQueryDto(), {
        page: query.page,
        limit: query.limit,
        org: id,
      }),
    );
  }

  @Post('organizations')
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'org.create' })
  @ApiEndpoint({
    summary: 'Add an organization with its Owner',
    description:
      "Set up a new organization in one step. First an account is created for the Owner, ready to use with no email verification step. Then the organization, its store and the Owner's membership are created together, so either everything is saved or nothing is. Sending the same request again for the same owner and store address is safe and does not create duplicates. If the setup fails, the new sign-in account is removed again. Each admin can do this at most 10 times in 10 minutes.",
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
  @PlatformAccess({ permission: 'tenants:read' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'View one organization',
    description:
      'Get the details of a single organization: the organization itself, its main store and its team. Private business data such as products, customers and orders is never included.',
    auth: 'platform',
    response: CompanyDetailDto,
    message: 'Organization retrieved successfully',
    errors: [404],
  })
  get(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orgs.get(admin.id, id);
  }

  @Patch('organizations/:id')
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Edit an organization',
    description:
      "Change an organization's name, contact phone number or address. Send only what you want to change. If nothing actually changed, nothing is saved and nothing is added to the activity log. Each admin can do this at most 60 times in 10 minutes.",
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'org.delete' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Delete an organization permanently',
    description:
      "Permanently delete an organization and everything inside it. The data is deleted in one go, so either all of it goes or none of it does. Afterwards the system also tries to delete the sign-in accounts of people who belonged to no other organization, and the organization's stored files. If that cleanup step fails, the organization is still deleted. This cannot be undone. Each admin can do this at most 5 times in 10 minutes.",
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Suspend or reactivate an organization',
    description:
      'Switch an organization off or back on. While an organization is suspended, none of its members can see or use it, and this is enforced in the database itself.',
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'org.edit' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Edit the main store',
    description:
      "Change an organization's main store: its name, description, contact details, currency and time zone. The store web address and logo cannot be changed here. The currency can no longer be changed once the store has products or orders.",
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Add a team member to an organization',
    description:
      'Create an account for a new team member and add them to this organization. It works the same way as when an Owner adds a member from their own Team page. You cannot make someone an Owner here. If adding them to the organization fails, the new sign-in account is removed again.',
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Disable or reactivate a team member',
    description:
      "Switch a team member's access to this organization off or back on. The Owner cannot be disabled. Transfer the ownership to someone else first.",
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'team.manage' })
  @ApiParam(ID)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Remove a team member',
    description:
      "Take a person off this organization's team. The Owner cannot be removed. If the person does not belong to any other organization, their sign-in account is deleted as well.",
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'ownership.change' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Transfer ownership to an existing member',
    description:
      'Make an existing team member the new Owner. The new owner must be an active member of the team. The change happens in one step: the old Owner becomes an ordinary team member (kept active or disabled), so there is never a moment with no owner or with two owners. Each admin can do this at most 5 times in 10 minutes.',
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
  @PlatformAccess({ permission: 'tenants:manage', bucket: 'ownership.change' })
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'Recover an organization with a new Owner',
    description:
      'Use this when an organization has lost its Owner or the Owner can no longer be reached. It creates a brand-new account, ready to use with no email verification step, and makes that account the Owner.',
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
