import { Module } from '@nestjs/common';
import {
  CHECKOUT_ADJUSTER,
  NoAdjustments,
  PAYMENT_METHOD_POLICY,
  UnconfiguredPaymentPolicy,
} from './checkout-hooks.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { JobsController } from './jobs.controller.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ReservationExpiryService } from './reservation-expiry.service.js';

@Module({
  controllers: [CheckoutController, OrdersController, JobsController],
  providers: [
    CheckoutService,
    OrdersService,
    ReservationExpiryService,
    // Replaced by the payments (Phase 4), shipping (Phase 8) and tax (Phase 10) modules.
    { provide: PAYMENT_METHOD_POLICY, useClass: UnconfiguredPaymentPolicy },
    { provide: CHECKOUT_ADJUSTER, useClass: NoAdjustments },
  ],
  exports: [CheckoutService, ReservationExpiryService],
})
export class OrdersModule {}
