import { Module } from '@nestjs/common';
import { PaymentMethodsPolicy } from '../payments/payment-methods.policy.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { CHECKOUT_ADJUSTER, PAYMENT_METHOD_POLICY } from './checkout-hooks.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { JobsController } from './jobs.controller.js';
import { OrdersController } from './orders.controller.js';
import { PublicShippingController } from './public-shipping.controller.js';
import { ShippingAdjuster } from './shipping-adjuster.js';
import { OrdersService } from './orders.service.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

@Module({
  imports: [PaymentsModule, ShippingModule],
  controllers: [
    CheckoutController,
    PublicShippingController,
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
  ],
  exports: [CheckoutService, OrdersService, ReservationExpiryService],
})
export class OrdersModule {}
