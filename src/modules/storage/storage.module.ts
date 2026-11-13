import { Module } from '@nestjs/common';
import { StorageReferencesService } from './storage-references.service.js';
import { StorageService } from './storage.service.js';
import { UploadsController } from './uploads.controller.js';

@Module({
  controllers: [UploadsController],
  providers: [StorageService, StorageReferencesService],
  exports: [StorageService, StorageReferencesService],
})
export class StorageModule {}
