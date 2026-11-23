import { Module } from '@nestjs/common';
import { CodController } from './cod.controller.js';
import { CodService } from './cod.service.js';
import { PaymentMethodsPolicy } from './payment-methods.policy.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsEventLogger } from './payments.logger.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayClient } from './razorpay.client.js';
import { RazorpayConnectionService } from './razorpay-connection.service.js';

@Module({
  controllers: [PaymentsController, CodController],
  providers: [
    PaymentsService,
    RazorpayConnectionService,
    RazorpayClient,
    CodService,
    PaymentMethodsPolicy,
    {
      provide: PaymentsEventLogger,
      useFactory: () => new PaymentsEventLogger(),
    },
  ],
  exports: [
    PaymentsEventLogger,
    RazorpayClient,
    PaymentMethodsPolicy,
    CodService,
  ],
})
export class PaymentsModule {}
