import { Module } from '@nestjs/common';
import { CatalogAssignmentsService } from './catalog-assignments.service.js';
import { CatalogImportService } from './catalog-import.service.js';
import { CatalogHierarchyController } from './catalog-hierarchy.controller.js';
import { CatalogHierarchyService } from './catalog-hierarchy.service.js';
import { PublicCatalogController } from './public-catalog.controller.js';
import { PublicCatalogService } from './public-catalog.service.js';

@Module({
  controllers: [CatalogHierarchyController, PublicCatalogController],
  providers: [
    CatalogHierarchyService,
    CatalogAssignmentsService,
    CatalogImportService,
    PublicCatalogService,
  ],
  exports: [CatalogHierarchyService, CatalogAssignmentsService],
})
export class CatalogHierarchyModule {}
