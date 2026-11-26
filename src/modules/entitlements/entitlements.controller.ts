import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { EntitlementsDto, EntitlementsQueryDto } from './entitlements.dto.js';
import { toEntitlementsDto } from './entitlements.mapper.js';
import { EntitlementsService } from './entitlements.service.js';

@ApiTags('entitlements')
@Controller('entitlements')
export class EntitlementsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  @RequirePermission('dashboard:view')
  @ApiEndpoint({
    summary: 'See what my plan includes and how much I have used',
    description:
      'The features switched on for this organization, its limits, how much of each is used, and a short list of the limits that are close or reached. Use it to hide or lock screens the plan does not include and to show usage notices. This is for display: the server refuses disallowed actions whatever the screen shows. Add `?storage=true` to also measure storage.',
    auth: 'org',
    permission: 'dashboard:view (any member)',
    response: EntitlementsDto,
    message: 'Entitlements retrieved successfully',
  })
  async mine(
    @CurrentOrg() org: OrgContext,
    @Query() query: EntitlementsQueryDto,
  ) {
    const { entitlements, limits } = await this.db.withUser(org.userId, (tx) =>
      this.entitlements.snapshot(tx, org.tenantId, query.storage),
    );
    return toEntitlementsDto(entitlements, limits);
  }
}
