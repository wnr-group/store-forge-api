import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { ProductExportService } from './product-export.service.js';
import { ProductImportService } from './product-import.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [StorageModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductImportService, ProductExportService],
})
export class ProductsModule {}
