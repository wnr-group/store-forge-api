import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { ProductImportService } from './product-import.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [StorageModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductImportService],
})
export class ProductsModule {}
