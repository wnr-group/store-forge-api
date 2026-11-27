import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { loginRequired } from '../customer-accounts/customer-session.service.js';
import {
  PlacedOrderDto,
  PlaceOrderDto,
  PublicOrderDto,
} from './checkout.dto.js';
import { CheckoutService } from './checkout.service.js';

/** Placing orders is the most abusable public write: a tighter limit than the global default. */
const PLACE_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const LOOKUP_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug/orders')
@Public()
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @Throttle(PLACE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'A unique key per checkout attempt (8-128 letters, numbers, - or _). Repeating the request with the same key returns the same order instead of creating another.',
  })
  @ApiHeader({
    name: 'X-Customer-Session',
    required: true,
    description:
      'The shopper session token from register/login for this store. Browsing and the cart need no account; placing an order does. Missing, expired or from another store: 401 `CUSTOMER_LOGIN_REQUIRED`.',
  })
  @ApiEndpoint({
    summary: 'Place an order',
    description:
      'Places an order from a cart for a signed-in shopper (the order is tied to their account). The server re-reads every product price and the stock from the database (browser prices are never trusted), holds the stock, and creates the order with its items, addresses and totals in one step. Cash-on-delivery orders are confirmed immediately. Online orders start as `pending_payment` and keep their stock reserved for a limited time. The response carries an `accessToken` ONCE; keep it to read or cancel the order later. If something in the cart changed you get a 409 `CHECKOUT_ISSUES` with the exact problems per item. Until the store has a payment method set up, you get a 409 `PAYMENT_METHOD_UNAVAILABLE`.',
    auth: 'public',
    body: PlaceOrderDto,
    response: PlacedOrderDto,
    status: 201,
    message: 'Order placed successfully',
    errors: [400, 401, 404, 409, 429],
  })
  place(
    @Param('slug') slug: string,
    @Body() dto: PlaceOrderDto,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-customer-session') session: string | undefined,
  ) {
    // Placing an order needs a signed-in shopper; the service then verifies the session against THIS store.
    if (!session) throw loginRequired();
    return this.checkout.placeOrder(slug.toLowerCase(), dto, key, session);
  }

  @Get(':orderNumber')
  @Throttle(LOOKUP_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader({
    name: 'X-Order-Token',
    required: true,
    description: 'The accessToken returned when the order was placed.',
  })
  @ApiEndpoint({
    summary: 'View your order',
    description:
      'Shows a shopper their own order, its items, totals and delivery address. Needs the order token from checkout. A wrong token and an unknown order look exactly the same (404).',
    auth: 'public',
    response: PublicOrderDto,
    message: 'Order retrieved successfully',
    errors: [404, 429],
  })
  get(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Headers('x-order-token') token: string | undefined,
  ) {
    return this.checkout.getOrder(slug.toLowerCase(), orderNumber, token);
  }

  @Post(':orderNumber/cancel')
  @Throttle(PLACE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'orderNumber', example: 1001 })
  @ApiHeader({ name: 'X-Order-Token', required: true })
  @ApiEndpoint({
    summary: 'Cancel your order',
    description:
      'Lets a shopper cancel their own order while it is still unpaid or waiting to be processed. Stock held or sold for it goes back on sale. A paid order cannot be cancelled here: it has to be refunded first (409 `REFUND_REQUIRED`).',
    auth: 'public',
    response: PublicOrderDto,
    message: 'Order cancelled successfully',
    errors: [404, 409, 429],
  })
  cancel(
    @Param('slug') slug: string,
    @Param('orderNumber', ParseIntPipe) orderNumber: number,
    @Headers('x-order-token') token: string | undefined,
  ) {
    return this.checkout.cancelOwnOrder(slug.toLowerCase(), orderNumber, token);
  }
}
