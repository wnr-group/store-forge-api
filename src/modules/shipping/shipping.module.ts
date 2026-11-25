import { Module } from '@nestjs/common';
import { CarrierSelectionService } from './carrier-selection.service.js';
import { CarriersController } from './carriers.controller.js';
import { CarriersService } from './carriers.service.js';
import { MethodsService } from './methods.service.js';
import { BlueDartProvider } from './providers/bluedart.provider.js';
import { CarrierHttp } from './providers/carrier-http.js';
import { DelhiveryProvider } from './providers/delhivery.provider.js';
import { ShippingProviderRegistry } from './providers/provider-registry.js';
import { ShiprocketProvider } from './providers/shiprocket.provider.js';
import { SHIPPING_PROVIDERS } from './providers/shipping-provider.js';
import { ShippingAdminController } from './shipping-admin.controller.js';
import { ShippingQuoteService } from './shipping-quote.service.js';
import { ShippingToolsService } from './shipping-tools.service.js';
import { ZonesService } from './zones.service.js';

/**
 * Carrier integrations behind one interface. To add a carrier: write a class implementing `ShippingProvider`, add it to
 * `providers` below and to the factory's `inject`/list. Nothing else changes.
 */
@Module({
  controllers: [CarriersController, ShippingAdminController],
  providers: [
    CarriersService,
    CarrierSelectionService,
    ShippingQuoteService,
    ShippingToolsService,
    ZonesService,
    MethodsService,
    CarrierHttp,
    ShiprocketProvider,
    DelhiveryProvider,
    BlueDartProvider,
    {
      provide: SHIPPING_PROVIDERS,
      useFactory: (...providers: unknown[]) => providers,
      inject: [ShiprocketProvider, DelhiveryProvider, BlueDartProvider],
    },
    ShippingProviderRegistry,
  ],
  exports: [
    ShippingProviderRegistry,
    CarriersService,
    CarrierSelectionService,
    ShippingQuoteService,
  ],
})
export class ShippingModule {}
