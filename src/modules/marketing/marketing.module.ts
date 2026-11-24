import { Module } from '@nestjs/common';
import { AbandonedCartsController } from './abandoned-carts.controller.js';
import { AbandonedCartsService } from './abandoned-carts.service.js';
import { CartRecoveryService } from './cart-recovery.service.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { CheckoutDiscountService } from './checkout-discount.service.js';
import { DiscountsController } from './discounts.controller.js';
import { DiscountsService } from './discounts.service.js';

/** Discount codes, promotional campaigns and abandoned carts (dashboard), and what the checkout and the storefront use of them. */
@Module({
  controllers: [
    DiscountsController,
    CampaignsController,
    AbandonedCartsController,
  ],
  providers: [
    DiscountsService,
    CampaignsService,
    CheckoutDiscountService,
    AbandonedCartsService,
    CartRecoveryService,
  ],
  exports: [CheckoutDiscountService, CartRecoveryService],
})
export class MarketingModule {}
