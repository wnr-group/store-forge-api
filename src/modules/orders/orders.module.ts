import { Module } from '@nestjs/common';
import { PaymentMethodsPolicy } from '../payments/payment-methods.policy.js';
import { PaymentsModule } from '../payments/payments.module.js';
import {
  CHECKOUT_ADJUSTER,
  NoAdjustments,
  PAYMENT_METHOD_POLICY,
} from './checkout-hooks.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { JobsController } from './jobs.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

@Module({
  imports: [PaymentsModule],
  controllers: [CheckoutController, OrdersController, JobsController],
  providers: [
    CheckoutService,
    OrdersService,
    ReservationExpiryService,
    // The tenant's own Razorpay and COD settings decide which methods an order may use.
    { provide: PAYMENT_METHOD_POLICY, useExisting: PaymentMethodsPolicy },
    // Replaced by the shipping (Phase 8) and tax (Phase 10) modules.
    { provide: CHECKOUT_ADJUSTER, useClass: NoAdjustments },
  ],
  exports: [CheckoutService, OrdersService, ReservationExpiryService],
})
export class OrdersModule {}
