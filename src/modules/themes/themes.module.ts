import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';
import { StoreThemeController, ThemesController } from './themes.controller.js';
import { ThemesRepository } from './themes.repository.js';
import { ThemesService } from './themes.service.js';

@Module({
  controllers: [ThemesController, StoreThemeController, TemplatesController],
  providers: [ThemesRepository, ThemesService, TemplatesService],
})
export class ThemesModule {}
