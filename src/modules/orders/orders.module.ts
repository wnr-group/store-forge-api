import { Module } from '@nestjs/common';
import { CustomerSessionModule } from '../customer-accounts/customer-session.module.js';
import { CheckoutDiscountService } from '../marketing/checkout-discount.service.js';
import { CartRecoveryService } from '../marketing/cart-recovery.service.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { CheckoutTaxService } from '../tax/checkout-tax.service.js';
import { TaxModule } from '../tax/tax.module.js';
import { PaymentMethodsPolicy } from '../payments/payment-methods.policy.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import {
  CHECKOUT_ADJUSTER,
  CHECKOUT_CART_TRACKER,
  CHECKOUT_DISCOUNTS,
  CHECKOUT_TAX,
  PAYMENT_METHOD_POLICY,
} from './checkout-hooks.js';
import { PublicCartController } from './public-cart.controller.js';
import { PublicDiscountController } from './public-discount.controller.js';
import { PublicQuoteController } from './public-quote.controller.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { JobsController } from './jobs.controller.js';
import { OrdersController } from './orders.controller.js';
import { PublicShippingController } from './public-shipping.controller.js';
import { ShippingAdjuster } from './shipping-adjuster.js';
import { OrdersService } from './orders.service.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

@Module({
  imports: [
    PaymentsModule,
    ShippingModule,
    TaxModule,
    MarketingModule,
    CustomerSessionModule,
  ],
  controllers: [
    CheckoutController,
    PublicShippingController,
    PublicQuoteController,
    PublicDiscountController,
    PublicCartController,
    OrdersController,
    JobsController,
  ],
  providers: [
    CheckoutService,
    OrdersService,
    ReservationExpiryService,
    // The tenant's own Razorpay and COD settings decide which methods an order may use.
    { provide: PAYMENT_METHOD_POLICY, useExisting: PaymentMethodsPolicy },
    // Shipping zones, methods and prices decide delivery and its charge (tax joins in the tax phase).
    { provide: CHECKOUT_ADJUSTER, useClass: ShippingAdjuster },
    // GST is worked out by the tax module from the tenant's own settings and the products' own rates.
    { provide: CHECKOUT_TAX, useExisting: CheckoutTaxService },
    // Discount codes are decided by the marketing module from the tenant's own codes.
    { provide: CHECKOUT_DISCOUNTS, useExisting: CheckoutDiscountService },
    // Saved carts are cleared (or marked recovered) when an order is placed.
    { provide: CHECKOUT_CART_TRACKER, useExisting: CartRecoveryService },
  ],
  exports: [CheckoutService, OrdersService, ReservationExpiryService],
})
export class OrdersModule {}
