import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  AdjustmentDto,
  AdjustmentsQueryDto,
  AdjustStockDto,
  InventoryQueryDto,
  InventoryRowDto,
  StockLevelDto,
} from './inventory.dto.js';
import { InventoryService } from './inventory.service.js';

@ApiTags('inventory')
@Controller('inventory')
@OrgScoped()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'View stock levels',
    description:
      'See how many items are available in your store, a page at a time. Products that come in different sizes, colors or other options are listed separately for each active option, so you can check each one on its own. Items that are out of stock appear first, followed by items running low. You can filter the list with `stock`: `in` (in stock), `low` (running low), `out` (out of stock) or `untracked` (stock is not being counted). Leave `stock` out to see everything. You can also search by product name, SKU (the product code) or option name.',
    auth: 'org',
    permission: 'catalog:view',
    response: [InventoryRowDto],
    paginated: true,
    message: 'Inventory retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: InventoryQueryDto) {
    return this.inventory.list(org, query);
  }

  @Get('adjustments')
  @RequirePermission('catalog:view')
  @ApiEndpoint({
    summary: 'View stock change history',
    description:
      'See the most recent changes made to stock levels, newest first. Every change is recorded here and old entries are never edited or removed, so it works as a permanent history.',
    auth: 'org',
    permission: 'catalog:view',
    response: [AdjustmentDto],
    message: 'Adjustments retrieved successfully',
  })
  adjustments(
    @CurrentOrg() org: OrgContext,
    @Query() query: AdjustmentsQueryDto,
  ) {
    return this.inventory.listAdjustments(org, query.limit);
  }

  @Post('adjustments')
  @RequirePermission('catalog:manage')
  @ApiEndpoint({
    summary: 'Change the stock of an item',
    description:
      'Add to, remove from, or set the stock of a product. The new quantity and its entry in the stock history are saved together, so they can never get out of step, and the item is locked while this happens so two people cannot overwrite each other. Stock can never go below zero. If the product has options such as sizes or colors, you must say which option you mean. If it has none, you must not. Products whose stock is not being tracked cannot be changed.',
    auth: 'org',
    permission: 'catalog:manage',
    body: AdjustStockDto,
    response: StockLevelDto,
    status: 201,
    message: 'Stock adjusted successfully',
    errors: [404],
  })
  adjust(@CurrentOrg() org: OrgContext, @Body() dto: AdjustStockDto) {
    return this.inventory.adjust(org, dto);
  }
}
