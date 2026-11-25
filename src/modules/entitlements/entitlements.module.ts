import { Global, Module } from '@nestjs/common';
import { EntitlementsController } from './entitlements.controller.js';
import { EntitlementsService } from './entitlements.service.js';

/** Global so any module can inject EntitlementsService without importing this one. */
@Global()
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
