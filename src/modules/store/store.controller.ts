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
    summary: 'View my store',
    description:
      'Get the main store of your organization (its oldest one). The response also includes `currencyLocked`, which tells you whether the store currency can still be changed.',
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
    summary: 'Edit store settings',
    description:
      'Change your store settings. Send only the fields you want to change. Fields you leave out stay as they are, and sending `null` for an optional field clears it. Once the store has products or orders, the currency can no longer be changed, because the prices are saved in that currency.',
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
