import { Module } from '@nestjs/common';
import { ShippingModule } from '../shipping/shipping.module.js';
import {
  CarrierWebhookController,
  ShipmentJobsController,
} from './carrier-webhook.controller.js';
import { ShipmentCarrier } from './shipment-carrier.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';
import { ShipmentsController } from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

/** Parcels booked with the tenants' own carriers: booking, cancelling, labels, and tracking that moves orders along. */
@Module({
  imports: [ShippingModule],
  controllers: [
    ShipmentsController,
    CarrierWebhookController,
    ShipmentJobsController,
  ],
  providers: [ShipmentCarrier, ShipmentsService, ShipmentTrackingService],
  exports: [ShipmentsService, ShipmentTrackingService],
})
export class ShipmentsModule {}
