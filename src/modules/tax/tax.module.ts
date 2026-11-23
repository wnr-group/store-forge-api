import { Module } from '@nestjs/common';
import { CheckoutTaxService } from './checkout-tax.service.js';
import { TaxController } from './tax.controller.js';
import { TaxService } from './tax.service.js';

/** GST: the seller's settings, the report, and the calculation the checkout asks for. */
@Module({
  controllers: [TaxController],
  providers: [TaxService, CheckoutTaxService],
  exports: [CheckoutTaxService],
})
export class TaxModule {}
