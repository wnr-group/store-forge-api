import { Global, Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller.js';
import { MonitoringRecorder } from './monitoring.recorder.js';
import { MonitoringService } from './monitoring.service.js';

/** Global so the scheduler controllers in other modules can record their runs without importing this module. */
@Global()
@Module({
  controllers: [MonitoringController],
  providers: [MonitoringRecorder, MonitoringService],
  exports: [MonitoringRecorder, MonitoringService],
})
export class MonitoringModule {}
