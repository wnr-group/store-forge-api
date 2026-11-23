import { Module } from '@nestjs/common';
import { CodController } from './cod.controller.js';
import { CodService } from './cod.service.js';
import { PaymentsLedgerController } from './payments-ledger.controller.js';
import { PaymentMethodsPolicy } from './payment-methods.policy.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsEventLogger } from './payments.logger.js';
import { PaymentsService } from './payments.service.js';
import { RefundsService } from './refunds.service.js';
import { TransactionsService } from './transactions.service.js';
import { RazorpayClient } from './razorpay.client.js';
import { RazorpayConnectionService } from './razorpay-connection.service.js';

@Module({
  controllers: [PaymentsController, CodController, PaymentsLedgerController],
  providers: [
    PaymentsService,
    RazorpayConnectionService,
    RazorpayClient,
    CodService,
    RefundsService,
    TransactionsService,
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
    RefundsService,
  ],
})
export class PaymentsModule {}
