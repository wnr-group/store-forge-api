import { Module } from '@nestjs/common';
import { ThemesRepository } from '../themes/themes.repository.js';
import { StorageModule } from '../storage/storage.module.js';
import { MediaService } from './media.service.js';
import { ReadinessService } from './readiness/readiness.service.js';
import { PlatformStudioService } from './platform-studio.service.js';
import { ReusableSectionsModule } from './reusable-sections/reusable-sections.module.js';
import {
  PlatformStudioController,
  StudioController,
} from './studio.controller.js';
import { StudioService } from './studio.service.js';

@Module({
  imports: [StorageModule, ReusableSectionsModule],
  controllers: [StudioController, PlatformStudioController],
  providers: [
    StudioService,
    PlatformStudioService,
    MediaService,
    ReadinessService,
    ThemesRepository,
  ],
  exports: [StudioService, ReadinessService, ReusableSectionsModule],
})
export class StudioModule {}
