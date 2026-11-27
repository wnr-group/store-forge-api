import { Module } from '@nestjs/common';
import { CustomerSessionService } from './customer-session.service.js';

/** Just the session check, so the orders module (which places orders from an account) can use it without importing the account area. */
@Module({
  providers: [CustomerSessionService],
  exports: [CustomerSessionService],
})
export class CustomerSessionModule {}
