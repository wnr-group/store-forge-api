import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsEventLogger } from './payments.logger.js';
import { PaymentsService } from './payments.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PaymentsEventLogger,
      useFactory: () => new PaymentsEventLogger(),
    },
  ],
})
export class PaymentsModule {}
