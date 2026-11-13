import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { OrganizationContextGuard } from './common/guards/organization-context.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { PlatformAdminGuard } from './common/guards/platform-admin.guard.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import configuration, { type AppConfig } from './config/configuration.js';
import { envFilePaths } from './config/env-files.js';
import { validateEnv } from './config/env.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { CollectionsModule } from './modules/collections/collections.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { PublicModule } from './modules/public/public.module.js';
import { TeamModule } from './modules/team/team.module.js';
import { ThemesModule } from './modules/themes/themes.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { StoreModule } from './modules/store/store.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: envFilePaths(),
      load: [configuration],
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const { ttlMs, limit } = config.get('throttle', { infer: true });
        return { throttlers: [{ ttl: ttlMs, limit }] };
      },
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    UsersModule,
    OrganizationsModule,
    StoreModule,
    StorageModule,
    CategoriesModule,
    CollectionsModule,
    ProductsModule,
    InventoryModule,
    CustomersModule,
    AnalyticsModule,
    TeamModule,
    ThemesModule,
    PublicModule,
    PlatformAdminModule,
  ],
  providers: [
    // Order matters: throttle -> CSRF -> authenticate -> resolve organization -> permission -> platform admin.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: OrganizationContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PlatformAdminGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
