import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { CheckoutPaymentsController } from './checkout-payments.controller.js';
import { CodCollectionController } from './cod-collection.controller.js';
import { CodCollectionService } from './cod-collection.service.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { RazorpayPaymentsService } from './razorpay-payments.service.js';
import {
  PaymentJobsController,
  RazorpayWebhookController,
} from './razorpay-webhook.controller.js';
import { RazorpayWebhookService } from './razorpay-webhook.service.js';

/**
 * Where orders and payments meet. OrdersModule depends on PaymentsModule for the payment-method rules and never the other
 * way round; this module sits on top of both and runs the payment flow of an order.
 */
@Module({
  imports: [OrdersModule, PaymentsModule],
  controllers: [
    CheckoutPaymentsController,
    CodCollectionController,
    RazorpayWebhookController,
    PaymentJobsController,
  ],
  providers: [
    RazorpayPaymentsService,
    CodCollectionService,
    RazorpayWebhookService,
    PaymentReconciliationService,
  ],
})
export class CheckoutPaymentsModule {}
