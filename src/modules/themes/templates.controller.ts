import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  PreviewBundleDto,
  PublishDto,
  PublishResultDto,
  RollbackDto,
  SaveDraftDto,
  TemplateDetailDto,
  TemplateSummaryDto,
  TemplateVersionDto,
} from './themes.dto.js';
import { TemplatesService } from './templates.service.js';

@ApiTags('store-design')
@Controller('store/templates')
@OrgScoped()
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'List your store pages',
    description:
      'See the pages and shared parts of your storefront design (home, product, collection, header, footer, announcement and theme settings). Each shows whether it is a draft, live, or live with newer unpublished changes.',
    auth: 'org',
    permission: 'dashboard:view',
    response: [TemplateSummaryDto],
    message: 'Pages retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext) {
    return this.templates.list(org);
  }

  @Get(':id')
  @RequirePermission('dashboard:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Open one page for editing',
    description:
      'Get the draft of a page together with its revision. Send the revision back when you save.',
    auth: 'org',
    permission: 'dashboard:view',
    response: TemplateDetailDto,
    message: 'Page retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(org, id);
  }

  @Get(':id/preview')
  @RequirePermission('dashboard:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get everything needed to preview a draft',
    description:
      'Get the draft page plus your draft theme settings, header, footer and announcement, ready to render. Only signed-in members of your organization can read drafts; shoppers never see them.',
    auth: 'org',
    permission: 'dashboard:view',
    response: PreviewBundleDto,
    message: 'Preview retrieved successfully',
    errors: [404],
  })
  preview(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.templates.preview(org, id);
  }

  @Put(':id/draft')
  @RequirePermission('store:manage')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Save a draft',
    description:
      'Save your changes to a page without publishing. Send the whole document and the revision you started from. If someone else saved first you get a 409 and nothing is overwritten. The document is checked before it is saved and problems are listed by field.',
    auth: 'org',
    permission: 'store:manage',
    body: SaveDraftDto,
    response: TemplateDetailDto,
    message: 'Draft saved successfully',
    errors: [404, 409],
  })
  saveDraft(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.templates.saveDraft(org, id, dto);
  }

  @Post(':id/publish')
  @RequirePermission('store:manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Publish one page',
    description:
      'Make the current draft of this page live. It is saved as a new numbered version that can never be changed. If the draft already matches the live version, nothing is created.',
    auth: 'org',
    permission: 'store:manage',
    body: PublishDto,
    response: PublishResultDto,
    message: 'Page published successfully',
    errors: [404, 409],
  })
  publish(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishDto,
  ) {
    return this.templates.publish(org, id, dto);
  }

  @Get(':id/versions')
  @RequirePermission('dashboard:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'See the publishing history of a page',
    description:
      'List the last 100 published versions of a page, newest first, and which one is live.',
    auth: 'org',
    permission: 'dashboard:view',
    response: [TemplateVersionDto],
    message: 'Versions retrieved successfully',
    errors: [404],
  })
  versions(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.templates.versions(org, id);
  }

  @Post(':id/rollback')
  @RequirePermission('store:manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Restore an earlier version',
    description:
      'Make an earlier published version live again. It is published as a new version, so the history stays complete, and your draft is reset to match. Products, collections and orders are not affected.',
    auth: 'org',
    permission: 'store:manage',
    body: RollbackDto,
    response: PublishResultDto,
    message: 'Version restored successfully',
    errors: [400, 404, 409],
  })
  rollback(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollbackDto,
  ) {
    return this.templates.rollback(org, id, dto);
  }
}
