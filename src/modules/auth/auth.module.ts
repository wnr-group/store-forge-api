import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SupabaseAdminService } from './supabase-admin.service.js';
import { SupabaseJwtService } from './supabase-jwt.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SupabaseJwtService, SupabaseAdminService],
  exports: [SupabaseJwtService, SupabaseAdminService],
})
export class AuthModule {}
