import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  RequirePermission,
} from '../../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../../common/interfaces/request-context.js';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { DbTx } from '../../../infrastructure/database/database.types.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  CreateTemplateDto,
  PublishDto,
  PublishResponseDto,
  RenameTemplateDto,
  RestoreVersionDto,
  RestoreVersionResponseDto,
  RollbackDto,
  RollbackResponseDto,
  SaveDraftDto,
  SaveDraftResponseDto,
  TemplateDetailDto,
  TemplateListQueryDto,
  TemplateSummaryDto,
  VersionDetailDto,
  VersionSummaryDto,
} from '../dto/index.js';
import { TemplatePublishService } from '../services/template-publish.service.js';
import { TemplateQueryService } from '../services/template-query.service.js';
import { TemplateService } from '../services/template.service.js';
import {
  mapTemplateDbError,
  TemplateNotFoundError,
} from '../support/template-errors.js';

async function verifyStoreInTenant(
  tx: DbTx,
  tenantId: string,
  storeId: string,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(
    sql`SELECT id FROM stores WHERE id = ${storeId} AND tenant_id = ${tenantId}`,
  );
  if (!rows[0]) {
    throw new TemplateNotFoundError(`Store not found: ${storeId}`);
  }
}

@ApiTags('templates')
@Controller('stores/:storeId/templates')
@OrgScoped()
export class TemplatesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateService: TemplateService,
    private readonly templatePublishService: TemplatePublishService,
    private readonly templateQueryService: TemplateQueryService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List page templates',
    auth: 'org',
    permission: 'store:manage',
    response: [TemplateSummaryDto],
    message: 'Templates retrieved successfully',
  })
  async list(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query() query: TemplateListQueryDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        await verifyStoreInTenant(tx, org.tenantId, storeId);
        return this.templateQueryService.listTemplates(
          tx,
          org.tenantId,
          storeId,
          {
            page: query.page,
            pageSize: query.pageSize,
          },
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post()
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @HttpCode(HttpStatus.CREATED)
  @ApiEndpoint({
    summary: 'Create a template from an approved preset',
    auth: 'org',
    permission: 'store:manage',
    body: CreateTemplateDto,
    response: TemplateDetailDto,
    status: 201,
    message: 'Template created successfully',
  })
  async create(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: CreateTemplateDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.createTemplate(
          tx,
          org.tenantId,
          storeId,
          dto,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Get(':templateId')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get template with draft and revision',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateDetailDto,
    message: 'Template retrieved successfully',
  })
  async get(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateQueryService.getTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Patch(':templateId')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Rename a template',
    auth: 'org',
    permission: 'store:manage',
    body: RenameTemplateDto,
    response: TemplateSummaryDto,
    message: 'Template renamed successfully',
  })
  async rename(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: RenameTemplateDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.renameTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
          dto.name,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Delete(':templateId')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiEndpoint({
    summary: 'Safely delete a template (never published, no assignments)',
    auth: 'org',
    permission: 'store:manage',
    response: null,
    status: 204,
    message: 'Template deleted successfully',
  })
  async delete(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      await this.db.withUser(user.id, async (tx) => {
        await this.templateService.deleteTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/duplicate')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @HttpCode(HttpStatus.CREATED)
  @ApiEndpoint({
    summary: 'Duplicate a template with fresh node IDs',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateDetailDto,
    status: 201,
    message: 'Template duplicated successfully',
  })
  async duplicate(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.duplicateTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/archive')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Archive a template',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateSummaryDto,
    message: 'Template archived successfully',
  })
  async archive(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.archiveTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/restore')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Restore an archived template',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateSummaryDto,
    message: 'Template restored successfully',
  })
  async restore(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.restoreTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Put(':templateId/draft')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Save mutable draft with optimistic revision check',
    auth: 'org',
    permission: 'store:manage',
    body: SaveDraftDto,
    response: SaveDraftResponseDto,
    message: 'Draft saved successfully',
  })
  async saveDraft(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: SaveDraftDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.saveDraft(
          tx,
          org.tenantId,
          storeId,
          templateId,
          dto.expectedRevision,
          dto.document,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/publish')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Publish template atomically with image verification',
    auth: 'org',
    permission: 'store:manage',
    body: PublishDto,
    response: PublishResponseDto,
    message: 'Template published successfully',
  })
  async publish(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: PublishDto,
  ) {
    try {
      const imageChecker = async (paths: string[]): Promise<string[]> => {
        const foreign = paths.filter((p) => !p.startsWith(`${org.tenantId}/`));
        if (foreign.length > 0) return foreign;
        return this.storage.findMissingObjects(user.token, paths);
      };

      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.publish(
          tx,
          org.tenantId,
          storeId,
          templateId,
          dto.expectedRevision,
          imageChecker,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/unpublish')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Unpublish template preserving historical versions',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateSummaryDto,
    message: 'Template unpublished successfully',
  })
  async unpublish(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.unpublish(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Get(':templateId/versions')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List published version metadata',
    auth: 'org',
    permission: 'store:manage',
    response: [VersionSummaryDto],
    message: 'Versions retrieved successfully',
  })
  async listVersions(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Query() query: TemplateListQueryDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateQueryService.listVersions(
          tx,
          org.tenantId,
          storeId,
          templateId,
          {
            page: query.page,
            pageSize: query.pageSize,
          },
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Get(':templateId/versions/:versionId')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get historical version with document',
    auth: 'org',
    permission: 'store:manage',
    response: VersionDetailDto,
    message: 'Version retrieved successfully',
  })
  async getVersion(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateQueryService.getVersion(
          tx,
          org.tenantId,
          storeId,
          templateId,
          versionId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/rollback')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Rollback to earlier published version',
    auth: 'org',
    permission: 'store:manage',
    body: RollbackDto,
    response: RollbackResponseDto,
    message: 'Template rolled back successfully',
  })
  async rollback(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: RollbackDto,
  ) {
    try {
      const imageChecker = async (paths: string[]): Promise<string[]> => {
        const foreign = paths.filter((p) => !p.startsWith(`${org.tenantId}/`));
        if (foreign.length > 0) return foreign;
        return this.storage.findMissingObjects(user.token, paths);
      };

      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.rollback(
          tx,
          org.tenantId,
          storeId,
          templateId,
          dto.versionId,
          imageChecker,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/restore-version')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Restore historical version into mutable draft',
    auth: 'org',
    permission: 'store:manage',
    body: RestoreVersionDto,
    response: RestoreVersionResponseDto,
    message: 'Version restored into draft successfully',
  })
  async restoreVersion(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: RestoreVersionDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.restoreVersion(
          tx,
          org.tenantId,
          storeId,
          templateId,
          dto.versionId,
          dto.expectedRevision,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':templateId/default')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({ name: 'templateId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Set template as the store default for its kind',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateSummaryDto,
    message: 'Default template updated successfully',
  })
  async setDefault(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateService.setDefaultTemplate(
          tx,
          org.tenantId,
          storeId,
          templateId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }
}
