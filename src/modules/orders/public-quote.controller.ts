import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { AppException } from '../../common/app.exception.js';
import { Public } from '../../common/decorators/decorators.js';
import { DatabaseService } from '../../database/database.service.js';
import { ShippingQuoteService } from '../shipping/shipping-quote.service.js';
import { destinationOf } from '../shipping/shipping-tools.service.js';
import { loadCatalog } from './catalog-loader.js';
import {
  CHECKOUT_DISCOUNTS,
  CHECKOUT_TAX,
  PAYMENT_METHOD_POLICY,
  type CheckoutDiscounts,
  type CheckoutTaxCalculator,
  type PaymentMethodPolicy,
} from './checkout-hooks.js';
import { cartWeightGrams, priceLines } from './checkout-pricing.js';
import { CheckoutService } from './checkout.service.js';
import { findIndianState } from './indian-states.js';
import { PublicQuoteDto, PublicQuoteResultDto } from './public-shipping.dto.js';
import { heldQuantities } from './stock-reservations.js';

const QUOTE_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug/checkout')
@Public()
export class PublicQuoteController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly quotes: ShippingQuoteService,
    private readonly db: DatabaseService,
    @Inject(PAYMENT_METHOD_POLICY)
    private readonly payments: PaymentMethodPolicy,
    @Inject(CHECKOUT_TAX) private readonly tax: CheckoutTaxCalculator,
    @Optional()
    @Inject(CHECKOUT_DISCOUNTS)
    private readonly discounts?: CheckoutDiscounts,
  ) {}

  @Post('quote')
  @HttpCode(200)
  @Throttle(QUOTE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Price a cart exactly as checkout would',
    description:
      "Returns the full price of a cart for an address: items, the chosen delivery option's charge, any cash-on-delivery charge, GST line by line (CGST+SGST within the seller's state, otherwise IGST) and the total, all worked out by the server with the same rules as placing the order. Show these figures; they are not a promise, the order is priced again when it is placed. Send the delivery option (`shippingMethodId`) for its charge to be included. 409 `CHECKOUT_ISSUES` when something in the cart needs attention.",
    auth: 'public',
    body: PublicQuoteDto,
    response: PublicQuoteResultDto,
    message: 'Quote calculated successfully',
    errors: [400, 404, 409, 429],
  })
  async quote(
    @Param('slug') slug: string,
    @Body() dto: PublicQuoteDto,
  ): Promise<PublicQuoteResultDto> {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    const requested = dto.lines.map((l) => ({
      productSlug: l.productSlug,
      variantId: l.variantId ?? null,
      quantity: l.quantity,
      expectedUnitPriceMinor: l.expectedUnitPriceMinor,
    }));
    const destination = destinationOf(dto.address, 'address.state');
    const state = findIndianState(dto.address.state)!;

    // 1. Price the cart from the database.
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
        { code: 'CHECKOUT_ISSUES', details: { issues: priced.issues } },
      );

    // 2. The delivery charge, if an option was chosen (may ask carriers, so no transaction is open).
    let shippingMinor = 0;
    if (dto.shippingMethodId) {
      const q = await this.quotes.options(store.tenantId, {
        destination,
        subtotalMinor: priced.subtotalMinor,
        weightGrams: cartWeightGrams(priced.lines),
        paymentMethod: dto.paymentMethod,
      });
      const option = q.options.find((o) => o.methodId === dto.shippingMethodId);
      if (!option)
        throw new AppException(
          'CONFLICT',
          'That delivery option is not available for this order. Please choose another.',
          { code: 'SHIPPING_METHOD_UNAVAILABLE' },
        );
      shippingMinor = option.chargeMinor;
    }

    // 3. Cash-on-delivery charge and tax, by the very code the order uses.
    return this.db.withCheckout(store.tenantId, async (tx) => {
      // The same code path the order uses decides the discount, so the quote and the order agree.
      let discountMinor = 0;
      let discountCode: string | null = null;
      if (dto.discountCode) {
        const d = this.discounts
          ? await this.discounts.resolve(tx, {
              tenantId: store.tenantId,
              code: dto.discountCode,
              lines: priced.lines,
              customerEmail: dto.customerEmail ?? null,
            })
          : null;
        if (!d?.ok)
          throw new AppException(
            'CONFLICT',
            d?.message ?? 'This discount code is not valid.',
            {
              code: 'DISCOUNT_INVALID',
              details: {
                reason: d?.reason ?? 'NOT_FOUND',
                minSubtotalMinor: d?.minSubtotalMinor ?? null,
              },
            },
          );
        discountMinor = d.discountMinor;
        discountCode = d.code;
      }
      const codFeeMinor =
        dto.paymentMethod === 'cod'
          ? (
              await this.payments.resolve(tx, {
                tenantId: store.tenantId,
                method: 'cod',
                subtotalMinor: priced.subtotalMinor,
                currency: store.currency,
              })
            ).codFeeMinor
          : 0;
      const t = await this.tax.compute(tx, {
        tenantId: store.tenantId,
        lines: priced.lines,
        discountMinor,
        shippingMinor,
        codFeeMinor,
        destination: {
          stateCode: state.code,
          stateName: state.name,
          city: dto.address.city ?? '',
          postalCode: dto.address.postalCode,
        },
      });
      return {
        currency: store.currency,
        subtotalMinor: priced.subtotalMinor,
        discountMinor,
        discountCode,
        shippingMinor,
        codFeeMinor,
        taxMinor: t.taxMinor,
        taxInclusive: t.inclusive,
        totalMinor:
          priced.subtotalMinor -
          discountMinor +
          shippingMinor +
          codFeeMinor +
          (t.inclusive ? 0 : t.taxMinor),
        tax: {
          regime: t.regime,
          stateTaxKind: t.stateTaxKind,
          inclusive: t.inclusive,
          sellerGstin: t.sellerGstin,
          placeOfSupplyStateCode: t.supplyStateCode,
          cgstMinor: t.cgstMinor,
          sgstMinor: t.sgstMinor,
          igstMinor: t.igstMinor,
          taxMinor: t.taxMinor,
          lines: t.lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            hsnCode: l.hsnCode,
            taxableMinor: l.taxableMinor,
            rateBps: l.rateBps,
            cgstMinor: l.cgstMinor,
            sgstMinor: l.sgstMinor,
            igstMinor: l.igstMinor,
            taxMinor: l.taxMinor,
          })),
        },
      };
    });
  }
}
