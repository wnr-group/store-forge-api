import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentUser,
  PlatformAccess,
} from '../../../common/decorators/decorators.js';
import type { AuthUser } from '../../../common/interfaces/request-context.js';
import {
  LimitUsageQueryDto,
  LimitUsageRowDto,
  SetFeatureOverrideDto,
  SetLimitOverrideDto,
  TenantEntitlementsDto,
} from './entitlements.dto.js';
import { PlatformEntitlementsService } from './entitlements.service.js';

const ID = { name: 'id', format: 'uuid', description: 'Organization id' };

@ApiTags('platform-admin')
@Controller('platform')
@PlatformAccess({ permission: 'subscriptions:read' })
export class PlatformEntitlementsController {
  constructor(private readonly entitlements: PlatformEntitlementsService) {}

  @Get('organizations/:id/entitlements')
  @ApiParam(ID)
  @ApiEndpoint({
    summary: 'View what an organization may use',
    description:
      'The features switched on for the organization, its limits with how much is used (storage included), the limits at warning or reached, and the exceptions set for this organization alone. Everything is worked out from its plan plus those exceptions, which always win.',
    auth: 'platform',
    permission: 'subscriptions:read',
    response: TenantEntitlementsDto,
    message: 'Entitlements retrieved successfully',
    errors: [404],
  })
  get(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.entitlements.get(admin.id, id);
  }

  @Put('organizations/:id/entitlements/features/:key')
  @PlatformAccess({
    permission: 'entitlements:manage',
    bucket: 'subscription.manage',
  })
  @ApiParam(ID)
  @ApiParam({ name: 'key', example: 'google_analytics' })
  @ApiEndpoint({
    summary: 'Switch a feature on or off for one organization',
    description:
      'Make an exception to the plan for this organization only: `true` forces the feature on, `false` forces it off, `null` removes the exception. Sending what is already set changes nothing and is not logged. Change what a whole plan includes on the plan itself.',
    auth: 'platform',
    permission: 'entitlements:manage',
    body: SetFeatureOverrideDto,
    response: TenantEntitlementsDto,
    message: 'Feature updated successfully',
    errors: [404],
  })
  setFeature(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() dto: SetFeatureOverrideDto,
  ) {
    return this.entitlements.setFeature(admin.id, id, key, dto);
  }

  @Put('organizations/:id/entitlements/limits/:key')
  @PlatformAccess({
    permission: 'entitlements:manage',
    bucket: 'subscription.manage',
  })
  @ApiParam(ID)
  @ApiParam({ name: 'key', example: 'products' })
  @ApiEndpoint({
    summary: 'Set a limit for one organization',
    description:
      'Give this organization its own soft and hard limit for a resource, whatever its plan says. Leave both empty for unlimited, or send `clear: true` to follow the plan again. The soft limit cannot be above the hard limit. Takes effect immediately for the next request. Sending what is already set changes nothing and is not logged.',
    auth: 'platform',
    permission: 'entitlements:manage',
    body: SetLimitOverrideDto,
    response: TenantEntitlementsDto,
    message: 'Limit updated successfully',
    errors: [404],
  })
  setLimit(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() dto: SetLimitOverrideDto,
  ) {
    return this.entitlements.setLimit(admin.id, id, key, dto);
  }

  @Get('limit-usage')
  @PlatformAccess({ permission: 'usage:read' })
  @ApiEndpoint({
    summary: 'Find organizations close to their limits',
    description:
      'Organizations with how much of each limit they use (products, staff accounts, orders this month), as a number and a percent of the hard limit, a page at a time. By default only organizations at a warning or a reached limit are listed; `filter=all` lists everyone. "Warning" means at or past the soft limit, or at 80% of the hard limit. Storage is not counted here: it is measured on the organization itself.',
    auth: 'platform',
    permission: 'usage:read',
    response: [LimitUsageRowDto],
    paginated: true,
    message: 'Limit usage retrieved successfully',
  })
  limitUsage(
    @CurrentUser() admin: AuthUser,
    @Query() query: LimitUsageQueryDto,
  ) {
    return this.entitlements.limitUsage(admin.id, query);
  }
}
