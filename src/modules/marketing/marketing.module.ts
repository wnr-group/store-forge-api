import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { CheckoutDiscountService } from './checkout-discount.service.js';
import { DiscountsController } from './discounts.controller.js';
import { DiscountsService } from './discounts.service.js';

/** Discount codes and promotional campaigns (dashboard), and the discount rules the checkout applies. */
@Module({
  controllers: [DiscountsController, CampaignsController],
  providers: [DiscountsService, CampaignsService, CheckoutDiscountService],
  exports: [CheckoutDiscountService],
})
export class MarketingModule {}
