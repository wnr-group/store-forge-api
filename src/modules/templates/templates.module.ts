import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { SharedDocumentsController } from './controllers/shared-documents.controller.js';
import { TemplateAssignmentsController } from './controllers/template-assignments.controller.js';
import { TemplateImagesController } from './controllers/template-images.controller.js';
import { TemplatesController } from './controllers/templates.controller.js';
import { TemplateAssignmentService } from './services/template-assignment.service.js';
import { TemplatePublishService } from './services/template-publish.service.js';
import { TemplateQueryService } from './services/template-query.service.js';
import { TemplateService } from './services/template.service.js';

@Module({
  imports: [DatabaseModule, StorageModule],
  controllers: [
    TemplatesController,
    SharedDocumentsController,
    TemplateAssignmentsController,
    TemplateImagesController,
  ],
  providers: [
    TemplateService,
    TemplatePublishService,
    TemplateAssignmentService,
    TemplateQueryService,
  ],
  exports: [
    TemplateService,
    TemplatePublishService,
    TemplateAssignmentService,
    TemplateQueryService,
  ],
})
export class TemplatesModule {}
