import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  CancelOrderDto,
  OrderDetailDto,
  OrderListQueryDto,
  OrderSummaryDto,
  UpdateOrderStatusDto,
} from './orders.dto.js';
import { OrdersService } from './orders.service.js';

const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('orders')
@Controller('orders')
@OrgScoped()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermission('orders:view')
  @ApiEndpoint({
    summary: 'List orders',
    description:
      'See your store orders, newest first, a page at a time. Search by order number, customer name or email, and filter by order status, payment status or payment method.',
    auth: 'org',
    permission: 'orders:view',
    response: [OrderSummaryDto],
    paginated: true,
    message: 'Orders retrieved successfully',
  })
  list(@CurrentOrg() org: OrgContext, @Query() query: OrderListQueryDto) {
    return this.orders.list(org, query);
  }

  @Get(':id')
  @RequirePermission('orders:view')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'View one order',
    description:
      'Everything about an order: items, amounts (subtotal, shipping, COD fee, tax, total), customer, addresses, the full status history, and which statuses it can move to next.',
    auth: 'org',
    permission: 'orders:view',
    response: OrderDetailDto,
    message: 'Order retrieved successfully',
    errors: [404],
  })
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(org, id);
  }

  @Post(':id/status')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Move an order to its next status',
    description:
      'Moves an order along its lifecycle (processing, ready to ship, shipped, out for delivery, delivered, returned). Only valid next steps are accepted; anything else is a 409 `ORDER_INVALID_TRANSITION`. Confirming or failing an unpaid order is done by the payment system, not by hand. To cancel use the cancel action.',
    auth: 'org',
    permission: 'orders:manage',
    body: UpdateOrderStatusDto,
    response: OrderDetailDto,
    message: 'Order status updated successfully',
    errors: [404, 409, 429],
  })
  updateStatus(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orders.updateStatus(org, id, dto);
  }

  @Post(':id/cancel')
  @Throttle(WRITE_LIMIT)
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Cancel an order',
    description:
      'Cancels an order that has not shipped. Held stock is released, and units already sold for it go back on sale. An order that was paid must be refunded first (409 `REFUND_REQUIRED`).',
    auth: 'org',
    permission: 'orders:manage',
    body: CancelOrderDto,
    response: OrderDetailDto,
    message: 'Order cancelled successfully',
    errors: [404, 409, 429],
  })
  cancel(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancel(org, id, dto);
  }
}
