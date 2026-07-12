import fs from 'node:fs';
import path from 'node:path';
import { CacheModule } from '@/core/cache/cache.module';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { DatabaseModule } from '@/core/database/database.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { I18nModule } from '@/modules/i18n/i18n.module';
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { APP_DIR } from './common/constants';
import { MainExceptionFilter } from './common/error/exception.filter';
import { FilesystemModule } from './core/filesystem/filesystem.module';
import { HealthModule } from './core/health/health.module';
import { LoggerModule } from './core/logger/logger.module';
import { LoggerService } from './core/logger/logger.service';
import { SSEModule } from './core/sse/sse.module';
import { AppLifecycleModule } from './modules/app-lifecycle/app-lifecycle.module';
import { AppStoreModule } from './modules/app-stores/app-store.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthMiddleware } from './modules/auth/auth.middleware';
import { BackupsModule } from './modules/backups/backups.module';
import { DebugModule } from './modules/debug/debug.module';
import { LinksModule } from './modules/links/links.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { NetworkModule } from './modules/network/network.module';
import { QueueModule } from './modules/queue/queue.module';
import { SystemModule } from './modules/system/system.module';
import { TailscaleModule } from './modules/tailscale/tailscale.module';
import { CloudflareModule } from './modules/cloudflare/cloudflare.module';
import { PublicWebModule } from './modules/public-web/public-web.module';
import { UserModule } from './modules/user/user.module';
import { UserConfigModule } from './modules/user-config/user-config.module';
import { MutexModule } from './utils/mutex/mutex.module';
import { DockerModule } from './modules/docker/docker.module';
import { ZodValidationPipe } from './common/zod-dto';
import { CustomAppsModule } from './modules/custom-apps/custom-apps.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { RegistryModule } from './utils/registry/registry.module';
import { SystemUpdateModule } from './modules/system-update/system-update.module';
import { McpModule } from './modules/mcp/mcp.module';
import { McpApiKeyModule } from './modules/mcp/mcp-api-key.module';
import { MemoryConnectModule } from './modules/memory-connect/memory-connect.module';
import { AgentNotifyModule } from './modules/agent-notify/agent-notify.module';
import { InferenceModule } from './modules/inference/inference.module';
import { PortalModule } from './core/portal/portal.module';
import { ErrorReportingModule } from './core/error-reporting/error-reporting.module';
import { SentryModule } from '@sentry/nestjs/setup';

const imports: (DynamicModule | typeof I18nModule)[] = [
  SentryModule.forRoot(),
  ErrorReportingModule,
  RegistrationModule,
  SystemModule,
  I18nModule,
  AuthModule,
  UserModule,
  ConfigurationModule,
  PortalModule,
  DatabaseModule,
  CacheModule,
  LoggerModule,
  AppsModule,
  FilesystemModule,
  AppStoreModule,
  QueueModule,
  AppLifecycleModule,
  LinksModule,
  BackupsModule,
  HealthModule,
  MarketplaceModule,
  SSEModule,
  NetworkModule,
  TailscaleModule,
  CloudflareModule,
  PublicWebModule,
  UserConfigModule,
  MutexModule,
  DockerModule,
  RegistryModule,
  CustomAppsModule,
  SystemUpdateModule,
  AgentNotifyModule,
  InferenceModule,
  // SEC-MCP-8: always available (not gated on MCP_ENABLED) — AppsModule provisions companion-app
  // managed keys and AppService seeds the legacy key regardless of whether the MCP endpoint is mounted.
  McpApiKeyModule,
  MemoryConnectModule,
];

// Gate on the built frontend bundle's presence, not NODE_ENV: the bundled
// Docker image ships index.html at /app/assets/frontend but runs with
// NODE_ENV=development (from .env.dev), which would otherwise 404 the UI.
// Local `pnpm dev` has no bundle, so Vite serves the frontend instead.
const frontendBundlePath = path.join(APP_DIR, 'assets', 'frontend');
const hasFrontendBundle = fs.existsSync(path.join(frontendBundlePath, 'index.html'));
if (hasFrontendBundle) {
  imports.push(
    ServeStaticModule.forRoot({
      rootPath: frontendBundlePath,
      exclude: ['/api*path'],
    }),
  );
}
if (process.env.NODE_ENV !== 'production') {
  imports.push(DebugModule);
}
if (process.env.MCP_ENABLED !== 'false') {
  imports.push(McpModule);
}

@Module({
  imports,
  providers: [
    AppService,
    AuthMiddleware,
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      provide: APP_FILTER,
      useFactory: (logger: LoggerService) => new MainExceptionFilter(logger),
      inject: [LoggerService],
    },
  ],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*all');
  }
}
