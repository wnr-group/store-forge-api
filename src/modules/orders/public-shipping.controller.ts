import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { AppException } from '../../common/app.exception.js';
import { Public } from '../../common/decorators/decorators.js';
import { DatabaseService } from '../../database/database.service.js';
import { ShippingQuoteService } from '../shipping/shipping-quote.service.js';
import { ShippingQuoteDto } from '../shipping/shipping-tools.dto.js';
import {
  destinationOf,
  publicQuote,
} from '../shipping/shipping-tools.service.js';
import { loadCatalog } from './catalog-loader.js';
import { cartWeightGrams, priceLines } from './checkout-pricing.js';
import { CheckoutService } from './checkout.service.js';
import { PublicShippingOptionsDto } from './public-shipping.dto.js';
import { heldQuantities } from './stock-reservations.js';

/** Carrier-priced options call outside services, so this is limited more tightly than a plain read. */
const OPTIONS_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug/shipping')
@Public()
export class PublicShippingController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly quotes: ShippingQuoteService,
    private readonly db: DatabaseService,
  ) {}

  @Post('options')
  @HttpCode(200)
  @Throttle(OPTIONS_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Delivery options for a cart and an address',
    description:
      "Tells the checkout page how this cart can be delivered to this address: whether the store delivers there, each delivery option with its price (worked out by the server from its own prices and weights), estimated delivery time, and whether cash on delivery may be used with it. Send the chosen option's `methodId` as `shippingMethodId` when placing the order. A store with no shipping zones answers `configured: false` and there is nothing to choose. If something in the cart needs attention you get the same 409 `CHECKOUT_ISSUES` as when placing an order.",
    auth: 'public',
    body: PublicShippingOptionsDto,
    response: ShippingQuoteDto,
    message: 'Delivery options retrieved successfully',
    errors: [400, 404, 409, 429],
  })
  async options(
    @Param('slug') slug: string,
    @Body() dto: PublicShippingOptionsDto,
  ) {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    const requested = dto.lines.map((l) => ({
      productSlug: l.productSlug,
      variantId: l.variantId ?? null,
      quantity: l.quantity,
      expectedUnitPriceMinor: l.expectedUnitPriceMinor,
    }));
    // The cart is read and priced from the database (no locks): subtotal and weight are never taken from the browser.
    const priced = await this.db.withCheckout(store.tenantId, async (tx) => {
      const { products, variants } = await loadCatalog(
        tx,
        store.tenantId,
        requested,
        false,
      );
      const held = await heldQuantities(
        tx,
        store.tenantId,
        products.map((p) => p.id),
      );
      return priceLines(requested, products, variants, held);
    });
    if (priced.issues.length > 0)
      throw new AppException(
        'CONFLICT',
        'Some items in your cart need attention.',
        {
          code: 'CHECKOUT_ISSUES',
          details: { issues: priced.issues },
        },
      );
    const quote = await this.quotes.options(store.tenantId, {
      destination: destinationOf(dto.address, 'address.state'),
      subtotalMinor: priced.subtotalMinor,
      weightGrams: cartWeightGrams(priced.lines),
      paymentMethod: dto.paymentMethod,
    });
    return publicQuote(quote);
  }
}
