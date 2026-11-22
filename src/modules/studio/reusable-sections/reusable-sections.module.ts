import { Module } from '@nestjs/common';
import { ReusableSectionsController } from './reusable-sections.controller.js';
import { ReusableSectionsService } from './reusable-sections.service.js';

@Module({
  controllers: [ReusableSectionsController],
  providers: [ReusableSectionsService],
  exports: [ReusableSectionsService],
})
export class ReusableSectionsModule {}
