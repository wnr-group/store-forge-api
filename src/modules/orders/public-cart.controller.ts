import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import {
  CartCheckpointDto,
  CartCheckpointResultDto,
  CartRecoveryDto,
} from '../marketing/abandoned-carts.dto.js';
import { CartRecoveryService } from '../marketing/cart-recovery.service.js';
import { CheckoutService } from './checkout.service.js';

/** Saving a cart is a public write: a limit per client. Opening a link is guess-resistant by its 256-bit token, but limited too. */
const CHECKPOINT_LIMIT = { default: { limit: 30, ttl: 60_000 } };
const RECOVERY_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug/cart')
@Public()
export class PublicCartController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly recovery: CartRecoveryService,
  ) {}

  @Post('checkpoint')
  @HttpCode(200)
  @Throttle(CHECKPOINT_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Save a cart so it can be recovered',
    description:
      'Call this once the shopper has typed their email at checkout, and again (debounced) when the cart changes. The server keeps the items (priced by itself), the email and whether the shopper agreed to be contacted. If they do not finish the order, the store owner sees the cart as abandoned and a recovery link can resume it. When the order is placed the saved cart is cleared automatically. Nothing is ever sent to the shopper from this; the shop only stores what was entered, so tell shoppers so and ask for consent to be contacted separately (`marketingConsent`). Failures here must never block checkout: ignore them.',
    auth: 'public',
    body: CartCheckpointDto,
    response: CartCheckpointResultDto,
    message: 'Cart saved successfully',
    errors: [400, 404, 429, 503],
  })
  async checkpoint(
    @Param('slug') slug: string,
    @Body() dto: CartCheckpointDto,
  ) {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    return this.recovery.checkpoint(store, dto);
  }

  @Get('recovery/:token')
  @Throttle(RECOVERY_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiParam({ name: 'token', description: 'The token from the recovery link.' })
  @ApiEndpoint({
    summary: 'Open a cart recovery link',
    description:
      'Returns what the saved cart held, priced now, plus the items that are no longer available. Put `lines` back in the cart and send the shopper to checkout (`email` and `customerName` can prefill the form). A wrong, expired or already used link all answer the same 404 `RECOVERY_LINK_INVALID`.',
    auth: 'public',
    response: CartRecoveryDto,
    message: 'Cart recovered successfully',
    errors: [404, 429],
  })
  async open(@Param('slug') slug: string, @Param('token') token: string) {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    return this.recovery.open(store, token);
  }
}
