import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import {
  CurrentOrg,
  OrgScoped,
  RequirePermission,
} from '../../common/decorators/decorators.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import {
  CreateDiscountDto,
  DiscountDetailDto,
  DiscountDto,
  DiscountListQueryDto,
  UpdateDiscountDto,
} from './discounts.dto.js';
import { DiscountsService } from './discounts.service.js';

const WRITE_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@ApiTags('marketing')
@Controller('marketing/discounts')
@OrgScoped()
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Get()
  @RequirePermission('marketing:view')
  @ApiEndpoint({
    summary: 'List discount codes',
    description:
      'Your discount codes, a page at a time, each with its status (`active`, `disabled`, `scheduled`, `expired`, `exhausted` or `campaign_inactive`) and how it performed: orders that used it, the total discounted, and the sales of the paid or fulfilled ones. Filter by `status` or `campaignId`, search by code or description.',
    auth: 'org',
    permission: 'marketing:view',
    response: [DiscountDto],
    paginated: true,
    message: 'Discount codes retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() q: DiscountListQueryDto) {
    return this.discounts.list(org, q);
  }

  @Get(':id')
  @RequirePermission('marketing:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one discount code',
    description:
      'A code with its settings, performance and the products or collections it is limited to.',
    auth: 'org',
    permission: 'marketing:view',
    response: DiscountDetailDto,
    message: 'Discount code retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.discounts.get(org, id);
  }

  @Post()
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiEndpoint({
    summary: 'Create a discount code',
    description:
      'Creates a code: a percentage (basis points, with an optional maximum) or a fixed amount, with an optional minimum purchase, start and expiry, total and per-customer usage limits, and a limit to selected products or collections. The code is stored in capitals and must be unique in your store (409 `DISCOUNT_CODE_TAKEN`). Whether a code applies is always decided by the server when an order is priced and placed.',
    auth: 'org',
    permission: 'marketing:manage',
    body: CreateDiscountDto,
    response: DiscountDetailDto,
    status: 201,
    message: 'Discount code created successfully',
    errors: [409, 429],
  })
  create(@CurrentOrg() org: OrgContext, @Body() dto: CreateDiscountDto) {
    return this.discounts.create(org, dto);
  }

  @Patch(':id')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Change or switch a discount code on or off',
    description:
      'Changes any setting except the code itself. `isActive: false` switches the code off immediately; orders already placed keep the discount they got. Send `null` to remove an optional limit or date.',
    auth: 'org',
    permission: 'marketing:manage',
    body: UpdateDiscountDto,
    response: DiscountDetailDto,
    message: 'Discount code updated successfully',
    errors: [404, 409, 429],
  })
  update(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiscountDto,
  ) {
    return this.discounts.update(org, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @RequirePermission('marketing:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Delete a discount code',
    description:
      'Deletes a code that no order has used. A code that has been used is part of order history: disable it instead (409 `DISCOUNT_HAS_USE`).',
    auth: 'org',
    permission: 'marketing:manage',
    response: null,
    message: 'Discount code deleted successfully',
    errors: [404, 409, 429],
  })
  async remove(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.discounts.remove(org, id);
  }
}
