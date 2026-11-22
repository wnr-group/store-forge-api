import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module.js';
import { ProductPresentationsController } from './product-presentations.controller.js';
import { ProductPresentationsRepository } from './product-presentations.repository.js';
import { ProductPresentationsService } from './product-presentations.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';
import { StoreThemeController, ThemesController } from './themes.controller.js';
import { ThemesRepository } from './themes.repository.js';
import { ThemesService } from './themes.service.js';

@Module({
  imports: [StudioModule],
  controllers: [
    ThemesController,
    StoreThemeController,
    TemplatesController,
    ProductPresentationsController,
  ],
  providers: [
    ThemesRepository,
    ThemesService,
    TemplatesService,
    ProductPresentationsRepository,
    ProductPresentationsService,
  ],
})
export class ThemesModule {}
