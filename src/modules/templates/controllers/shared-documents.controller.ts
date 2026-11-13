import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
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
import { SHARED_KINDS } from '../../../infrastructure/database/template-deps/document.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  PublishDto,
  PublishResponseDto,
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
import {
  mapTemplateDbError,
  TemplateNotFoundError,
  TemplateValidationError,
} from '../support/template-errors.js';

export type SharedKind = (typeof SHARED_KINDS)[number];

function assertSharedKind(kind: string): asserts kind is SharedKind {
  if (!SHARED_KINDS.includes(kind as SharedKind)) {
    throw new TemplateValidationError(
      `Invalid shared document kind: ${kind}. Allowed kinds: ${SHARED_KINDS.join(', ')}`,
    );
  }
}

async function resolveSharedTemplate(
  queryService: TemplateQueryService,
  tx: DbTx,
  tenantId: string,
  storeId: string,
  kind: string,
): Promise<{ id: string; revision: number }> {
  const doc = await queryService.getSharedDocument(tx, tenantId, storeId, kind);
  if (!doc.id) {
    throw new TemplateNotFoundError(
      `Shared document '${kind}' has not been saved yet`,
    );
  }
  return { id: doc.id, revision: doc.revision };
}

@ApiTags('shared-documents')
@Controller('stores/:storeId/shared-documents')
@OrgScoped()
export class SharedDocumentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly templatePublishService: TemplatePublishService,
    private readonly templateQueryService: TemplateQueryService,
    private readonly storage: StorageService,
  ) {}

  @Get(':kind')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'Get effective shared document (lazily initialized)',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateDetailDto,
    message: 'Shared document retrieved successfully',
  })
  async get(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templateQueryService.getSharedDocument(
          tx,
          org.tenantId,
          storeId,
          kind,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Put(':kind')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary:
      'Save shared draft (first save creates row lazily with expectedRevision: 0)',
    auth: 'org',
    permission: 'store:manage',
    body: SaveDraftDto,
    response: SaveDraftResponseDto,
    message: 'Shared draft saved successfully',
  })
  async save(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Body() dto: SaveDraftDto,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return this.templatePublishService.saveSharedDraft(
          tx,
          org.tenantId,
          storeId,
          kind,
          dto.expectedRevision,
          dto.document,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':kind/publish')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'Publish shared document',
    auth: 'org',
    permission: 'store:manage',
    body: PublishDto,
    response: PublishResponseDto,
    message: 'Shared document published successfully',
  })
  async publish(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Body() dto: PublishDto,
  ) {
    assertSharedKind(kind);
    try {
      const imageChecker = async (paths: string[]): Promise<string[]> => {
        const foreign = paths.filter((p) => !p.startsWith(`${org.tenantId}/`));
        if (foreign.length > 0) return foreign;
        return this.storage.findMissingObjects(user.token, paths);
      };

      return await this.db.withUser(user.id, async (tx) => {
        const shared = await resolveSharedTemplate(
          this.templateQueryService,
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        return this.templatePublishService.publish(
          tx,
          org.tenantId,
          storeId,
          shared.id,
          dto.expectedRevision,
          imageChecker,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':kind/unpublish')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'Unpublish shared document',
    auth: 'org',
    permission: 'store:manage',
    response: TemplateSummaryDto,
    message: 'Shared document unpublished successfully',
  })
  async unpublish(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const shared = await resolveSharedTemplate(
          this.templateQueryService,
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        return this.templatePublishService.unpublish(
          tx,
          org.tenantId,
          storeId,
          shared.id,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Get(':kind/versions')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'List shared document versions',
    auth: 'org',
    permission: 'store:manage',
    response: [VersionSummaryDto],
    message: 'Shared versions retrieved successfully',
  })
  async listVersions(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Query() query: TemplateListQueryDto,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const doc = await this.templateQueryService.getSharedDocument(
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        if (!doc.id) {
          return {
            items: [],
            total: 0,
            page: query.page ?? 1,
            pageSize: query.pageSize ?? 20,
          };
        }
        return this.templateQueryService.listVersions(
          tx,
          org.tenantId,
          storeId,
          doc.id,
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

  @Get(':kind/versions/:versionId')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Get shared document version',
    auth: 'org',
    permission: 'store:manage',
    response: VersionDetailDto,
    message: 'Shared version retrieved successfully',
  })
  async getVersion(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const shared = await resolveSharedTemplate(
          this.templateQueryService,
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        return this.templateQueryService.getVersion(
          tx,
          org.tenantId,
          storeId,
          shared.id,
          versionId,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':kind/rollback')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'Rollback shared document to earlier version',
    auth: 'org',
    permission: 'store:manage',
    body: RollbackDto,
    response: RollbackResponseDto,
    message: 'Shared document rolled back successfully',
  })
  async rollback(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Body() dto: RollbackDto,
  ) {
    assertSharedKind(kind);
    try {
      const imageChecker = async (paths: string[]): Promise<string[]> => {
        const foreign = paths.filter((p) => !p.startsWith(`${org.tenantId}/`));
        if (foreign.length > 0) return foreign;
        return this.storage.findMissingObjects(user.token, paths);
      };

      return await this.db.withUser(user.id, async (tx) => {
        const shared = await resolveSharedTemplate(
          this.templateQueryService,
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        return this.templatePublishService.rollback(
          tx,
          org.tenantId,
          storeId,
          shared.id,
          dto.versionId,
          imageChecker,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post(':kind/restore-version')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiParam({
    name: 'kind',
    enum: SHARED_KINDS,
    description: 'Shared document kind',
  })
  @ApiEndpoint({
    summary: 'Restore shared document historical version into mutable draft',
    auth: 'org',
    permission: 'store:manage',
    body: RestoreVersionDto,
    response: RestoreVersionResponseDto,
    message: 'Shared version restored into draft successfully',
  })
  async restoreVersion(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Param('kind') kind: string,
    @Body() dto: RestoreVersionDto,
  ) {
    assertSharedKind(kind);
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const shared = await resolveSharedTemplate(
          this.templateQueryService,
          tx,
          org.tenantId,
          storeId,
          kind,
        );
        return this.templatePublishService.restoreVersion(
          tx,
          org.tenantId,
          storeId,
          shared.id,
          dto.versionId,
          dto.expectedRevision,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }
}
