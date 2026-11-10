import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  CurrentUser,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type {
  AuthUser,
  OrgContext,
} from '../../common/interfaces/request-context.js';
import { StoreDto, UpdateStoreDto } from './store.dto.js';
import { StoreService } from './store.service.js';

@ApiTags('store')
@Controller('store')
@OrgScoped()
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @ApiEndpoint({
    summary: "Read the organization's store",
    description:
      'The primary (oldest) store of the selected organization, with `currencyLocked` telling whether the currency can still change.',
    auth: 'org',
    response: StoreDto,
    message: 'Store retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext) {
    return this.store.get(org);
  }

  @Patch()
  @RequirePermission('store:manage')
  @ApiEndpoint({
    summary: 'Update store settings',
    description:
      'Partial update. Omitted fields keep their value; `null` clears an optional field. The currency cannot change once products or orders exist.',
    auth: 'org',
    permission:
      'store:manage (Owner, or a member with write access to settings)',
    body: UpdateStoreDto,
    response: StoreDto,
    message: 'Store updated successfully',
    errors: [404, 409],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateStoreDto,
  ) {
    return this.store.update(org, user, dto);
  }
}
