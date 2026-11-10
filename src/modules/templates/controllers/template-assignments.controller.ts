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
import {
  AssignmentResultsDto,
  BulkAssignmentsDto,
  BulkUnassignDto,
} from '../dto/index.js';
import { TemplateAssignmentService } from '../services/template-assignment.service.js';
import { mapTemplateDbError } from '../support/template-errors.js';

@ApiTags('template-assignments')
@Controller('stores/:storeId/template-assignments')
@OrgScoped()
export class TemplateAssignmentsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly templateAssignmentService: TemplateAssignmentService,
  ) {}

  @Get()
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'List template assignments for a store',
    auth: 'org',
    permission: 'store:manage',
    message: 'Assignments retrieved successfully',
  })
  async list(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        return tx.execute(
          sql`SELECT id, template_id as "templateId", product_id as "productId", collection_id as "collectionId"
              FROM template_assignments 
              WHERE store_id = ${storeId} AND tenant_id = ${org.tenantId}`,
        );
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Put()
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiEndpoint({
    summary:
      'Assign or replace template assignments (single or bulk up to 100)',
    auth: 'org',
    permission: 'store:manage',
    body: BulkAssignmentsDto,
    response: AssignmentResultsDto,
    message: 'Assignments updated successfully',
  })
  async assign(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: BulkAssignmentsDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const results = await this.templateAssignmentService.assign(
          tx,
          org.tenantId,
          storeId,
          dto.assignments,
        );
        return { results };
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }

  @Post('unassign')
  @RequirePermission('store:manage')
  @ApiParam({ name: 'storeId', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Unassign templates from resources (single or bulk up to 100)',
    auth: 'org',
    permission: 'store:manage',
    body: BulkUnassignDto,
    response: AssignmentResultsDto,
    message: 'Resources unassigned successfully',
  })
  async unassign(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body() dto: BulkUnassignDto,
  ) {
    try {
      return await this.db.withUser(user.id, async (tx) => {
        const results = await this.templateAssignmentService.unassign(
          tx,
          org.tenantId,
          storeId,
          dto.resources,
        );
        return { results };
      });
    } catch (err) {
      throw mapTemplateDbError(err);
    }
  }
}
