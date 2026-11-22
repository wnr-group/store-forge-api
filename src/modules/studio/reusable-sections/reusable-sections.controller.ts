import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import { CurrentOrg, CurrentUser, OrgScoped, RequirePermission } from '../../../common/decorators/decorators.js';
import type { AuthUser, OrgContext } from '../../../common/interfaces/request-context.js';
import {
  CreateReusableSectionDto,
  RestoreReusableSectionVersionDto,
  UpdateReusableSectionDto,
} from './reusable-sections.dto.js';
import { ReusableSectionsService } from './reusable-sections.service.js';

@ApiTags('studio')
@Controller('store/studio/reusable-sections')
@OrgScoped()
export class ReusableSectionsController {
  constructor(private readonly service: ReusableSectionsService) {}

  @Get()
  @RequirePermission('design:view')
  @ApiEndpoint({
    summary: 'List reusable sections',
    description: 'List all active reusable sections with their usage counts and current versions.',
    auth: 'org',
    permission: 'design:view',
    message: 'Reusable sections retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.service.list(org);
  }

  @Post()
  @RequirePermission('design:edit')
  @ApiEndpoint({
    summary: 'Create reusable section',
    description: 'Create a new reusable section and its initial version.',
    auth: 'org',
    permission: 'design:edit',
    body: CreateReusableSectionDto,
    status: 201,
    message: 'Reusable section created successfully',
    errors: [400, 403],
  })
  create(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReusableSectionDto,
  ) {
    return this.service.create(org, user, dto);
  }

  @Get(':id')
  @RequirePermission('design:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get reusable section',
    description: 'Get a reusable section and its current version content.',
    auth: 'org',
    permission: 'design:view',
    message: 'Reusable section retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(org, id);
  }

  @Put(':id')
  @RequirePermission('design:edit')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Update reusable section',
    description: 'Update metadata and optionally create a new immutable version.',
    auth: 'org',
    permission: 'design:edit',
    body: UpdateReusableSectionDto,
    message: 'Reusable section updated successfully',
    errors: [400, 403, 404],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReusableSectionDto,
  ) {
    return this.service.update(org, user, id, dto);
  }

  @Get(':id/versions')
  @RequirePermission('design:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List versions of reusable section',
    description: 'Get the full version history of a reusable section.',
    auth: 'org',
    permission: 'design:view',
    message: 'Reusable section versions retrieved successfully',
    errors: [404],
  })
  getVersions(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getVersions(org, id);
  }

  @Post(':id/restore')
  @RequirePermission('design:edit')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Restore previous version',
    description: 'Restore a previous version by creating a new version with its content.',
    auth: 'org',
    permission: 'design:edit',
    body: RestoreReusableSectionVersionDto,
    message: 'Reusable section version restored successfully',
    errors: [400, 403, 404],
  })
  restore(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestoreReusableSectionVersionDto,
  ) {
    return this.service.restoreVersion(org, user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('design:edit')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete reusable section',
    description: 'Archive a reusable section. Refuses with 409 Conflict if used by any active template.',
    auth: 'org',
    permission: 'design:edit',
    message: 'Reusable section deleted successfully',
    errors: [403, 404, 409],
  })
  delete(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(org, id);
  }
}
