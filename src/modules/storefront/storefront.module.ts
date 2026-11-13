import { Module } from '@nestjs/common';
import { StorefrontService } from './storefront.service.js';

@Module({
  providers: [StorefrontService],
  exports: [StorefrontService],
})
export class StorefrontModule {}
