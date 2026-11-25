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
import { AppException } from '../../common/app.exception.js';
import { ApiEndpoint } from '../../common/decorators/api-endpoint.decorator.js';
import { Public } from '../../common/decorators/decorators.js';
import { DatabaseService } from '../../database/database.service.js';
import { loadCatalog } from './catalog-loader.js';
import {
  CHECKOUT_DISCOUNTS,
  type CheckoutDiscounts,
} from './checkout-hooks.js';
import { priceLines } from './checkout-pricing.js';
import { CheckoutService } from './checkout.service.js';
import {
  ValidateDiscountDto,
  ValidateDiscountResultDto,
} from './public-shipping.dto.js';
import { heldQuantities } from './stock-reservations.js';

/** Guessing codes is the abuse here: a tight limit per client. */
const VALIDATE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('checkout')
@Controller('public/stores/:slug/discounts')
@Public()
export class PublicDiscountController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly db: DatabaseService,
    @Optional()
    @Inject(CHECKOUT_DISCOUNTS)
    private readonly discounts?: CheckoutDiscounts,
  ) {}

  @Post('validate')
  @HttpCode(200)
  @Throttle(VALIDATE_LIMIT)
  @ApiParam({ name: 'slug', example: 'acme-store' })
  @ApiEndpoint({
    summary: 'Check a discount code against a cart',
    description:
      'Tells a shopper whether a discount code works for their cart and how much it takes off, using exactly the rules the order uses (active, dates, usage limits, minimum purchase, eligible products). A code that does not apply is a normal answer (`valid: false` with a `reason`), not an error. This is a preview: the order checks the code again, under a lock, when it is placed. Limited to 30 checks a minute.',
    auth: 'public',
    body: ValidateDiscountDto,
    response: ValidateDiscountResultDto,
    message: 'Discount code checked successfully',
    errors: [400, 404, 409, 429],
  })
  async validate(
    @Param('slug') slug: string,
    @Body() dto: ValidateDiscountDto,
  ): Promise<ValidateDiscountResultDto> {
    const store = await this.checkout.resolveStore(slug.toLowerCase());
    const requested = dto.lines.map((l) => ({
      productSlug: l.productSlug,
      variantId: l.variantId ?? null,
      quantity: l.quantity,
      expectedUnitPriceMinor: l.expectedUnitPriceMinor,
    }));
    return this.db.withCheckout(store.tenantId, async (tx) => {
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
      const priced = priceLines(requested, products, variants, held);
      if (priced.issues.length > 0)
        throw new AppException(
          'CONFLICT',
          'Some items in your cart need attention.',
          { code: 'CHECKOUT_ISSUES', details: { issues: priced.issues } },
        );
      const result = this.discounts
        ? await this.discounts.resolve(tx, {
            tenantId: store.tenantId,
            code: dto.code,
            lines: priced.lines,
            customerEmail: dto.customerEmail ?? null,
          })
        : null;
      if (result?.ok)
        return {
          valid: true,
          code: result.code,
          discountMinor: result.discountMinor,
          eligibleSubtotalMinor: result.eligibleSubtotalMinor,
          reason: null,
          message: null,
          minSubtotalMinor: null,
        };
      return {
        valid: false,
        code: null,
        discountMinor: 0,
        eligibleSubtotalMinor: 0,
        reason: result?.reason ?? 'NOT_FOUND',
        message: result?.message ?? 'This discount code is not valid.',
        minSubtotalMinor: result?.minSubtotalMinor ?? null,
      };
    });
  }
}
