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
    summary: 'Stock levels',
    description:
      'One row per sellable unit: a simple product, or each active variant of a product with variants. Out-of-stock first, then low stock. Filter with `stock=in|low|out|untracked`.',
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
    summary: 'Recent stock adjustments',
    description: 'The append-only stock ledger, newest first.',
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
    summary: 'Adjust stock',
    description:
      'Changes the quantity and writes a ledger row in one transaction, with the row locked. Stock can never go below zero; a variant is required exactly when the product has variants; untracked products are refused.',
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
