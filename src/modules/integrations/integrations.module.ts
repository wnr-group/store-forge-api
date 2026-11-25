import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { PublicTrackingController } from './public-tracking.controller.js';

/** A store's own marketing and analytics connections (Google Analytics 4 today): configure, validate, test, switch on and off. */
@Module({
  imports: [OrdersModule],
  controllers: [IntegrationsController, PublicTrackingController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
