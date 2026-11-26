import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import { OrderDetailDto } from '../orders/orders.dto.js';
import { OrdersService } from '../orders/orders.service.js';
import { CodCollectionService } from './cod-collection.service.js';

@ApiTags('orders')
@Controller('orders')
@OrgScoped()
export class CodCollectionController {
  constructor(
    private readonly collection: CodCollectionService,
    private readonly orders: OrdersService,
  ) {}

  @Post(':id/cod/collect')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('orders:manage')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEndpoint({
    summary: 'Mark cash on delivery as collected',
    description:
      'Records that the cash for a cash-on-delivery order was collected. Allowed once the order has been handed to the carrier. Until then the order stays `pending_collection`, and it is never treated as paid. Repeating it is safe.',
    auth: 'org',
    permission: 'orders:manage',
    response: OrderDetailDto,
    message: 'Cash on delivery marked as collected',
    errors: [404, 409, 429],
  })
  async collect(
    @CurrentOrg() org: OrgContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.collection.collect(org, id);
    return this.orders.get(org, id);
  }
}
