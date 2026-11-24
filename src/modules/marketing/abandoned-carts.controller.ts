import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
  RequireFeature,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  AbandonedCartDetailDto,
  AbandonedCartDto,
  AbandonedCartListQueryDto,
  AbandonedCartSettingsDto,
  AbandonedCartSummaryDto,
  AbandonedCartSummaryQueryDto,
  SaveAbandonedCartSettingsDto,
} from './abandoned-carts.dto.js';
import { AbandonedCartsService } from './abandoned-carts.service.js';

const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('marketing')
@Controller('marketing/abandoned-carts')
@OrgScoped()
@RequireFeature('abandoned_cart_recovery')
export class AbandonedCartsController {
  constructor(private readonly carts: AbandonedCartsService) {}

  @Get()
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'List abandoned carts',
    description:
      'Carts of shoppers who gave an email at checkout, a page at a time, with their status (`active`, `abandoned`, `expired` or `recovered`), items count, value, last activity and abandonment date. A cart counts as abandoned after the idle time set in the settings (60 minutes by default) and as expired after the recovery window. Filter by `status`, a last-activity date range or a name/email search.',
    auth: 'org',
    permission: 'marketing:view',
    response: [AbandonedCartDto],
    paginated: true,
    message: 'Abandoned carts retrieved successfully',
    errors: [400],
  })
  list(@CurrentOrg() org: OrgContext, @Query() q: AbandonedCartListQueryDto) {
    return this.carts.list(org, q);
  }

  // Declared before `:id` so these names are never read as an id.
  @Get('summary')
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'Abandoned cart totals',
    description:
      'How many carts were abandoned in a period and what they were worth, how many came back and bought (with what those orders came to), and the recovery rate. Days are in your store time zone; the default is the last 30 days.',
    auth: 'org',
    permission: 'marketing:view',
    response: AbandonedCartSummaryDto,
    message: 'Abandoned cart summary retrieved successfully',
    errors: [400],
  })
  summary(
    @CurrentOrg() org: OrgContext,
    @Query() q: AbandonedCartSummaryQueryDto,
  ) {
    return this.carts.summary(org, q);
  }

  @Get('settings')
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'View abandoned cart settings',
    description:
      'After how many idle minutes a cart counts as abandoned, and for how many days a recovery link keeps working. `configured: false` until saved; the defaults (60 minutes, 14 days) then apply.',
    auth: 'org',
    permission: 'marketing:view',
    response: AbandonedCartSettingsDto,
    message: 'Abandoned cart settings retrieved successfully',
  })
  settings(@CurrentOrg() org: OrgContext) {
    return this.carts.settings(org);
  }

  @Put('settings')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('store:manage')
  @ApiEndpoint({
    summary: 'Save abandoned cart settings',
    description:
      'Sets the abandonment threshold (15 minutes to 7 days) and the recovery link lifetime (1 to 90 days). Applies to carts already waiting too, because abandonment is worked out when carts are read.',
    auth: 'org',
    permission: 'store:manage',
    body: SaveAbandonedCartSettingsDto,
    response: AbandonedCartSettingsDto,
    message: 'Abandoned cart settings saved successfully',
    errors: [429],
  })
  saveSettings(
    @CurrentOrg() org: OrgContext,
    @Body() dto: SaveAbandonedCartSettingsDto,
  ) {
    return this.carts.saveSettings(org, dto);
  }

  @Get(':id')
  @RequirePermission('marketing:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one abandoned cart',
    description:
      "The items (as last saved), the customer and the recovery link path for a cart that is still worth recovering (`recoveryPath`, to be prefixed with your store address). Nothing is sent to the customer from here: email and SMS recovery are future integrations and need the customer's consent.",
    auth: 'org',
    permission: 'marketing:view',
    response: AbandonedCartDetailDto,
    message: 'Abandoned cart retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.carts.get(org, id);
  }

  @Delete(':id')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Erase an abandoned cart',
    description:
      'Permanently removes the saved cart and the customer details kept with it (for example when a customer asks for their data to be deleted). Its recovery link stops working.',
    auth: 'org',
    permission: 'marketing:manage',
    response: null,
    message: 'Abandoned cart erased successfully',
    errors: [404, 429],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.carts.remove(org, id);
  }
}
