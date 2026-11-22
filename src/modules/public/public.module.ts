import { Module } from '@nestjs/common';
import { RecommendationsModule } from '../recommendations/recommendations.module.js';
import { PublicController } from './public.controller.js';
import { PublicService } from './public.service.js';

@Module({
  imports: [RecommendationsModule],
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}
