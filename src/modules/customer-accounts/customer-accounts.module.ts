import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { CustomerAccountsController } from './customer-accounts.controller.js';
import { CustomerAccountsService } from './customer-accounts.service.js';
import { CustomerSessionModule } from './customer-session.module.js';

@Module({
  imports: [CustomerSessionModule, OrdersModule],
  controllers: [CustomerAccountsController],
  providers: [CustomerAccountsService],
})
export class CustomerAccountsModule {}
