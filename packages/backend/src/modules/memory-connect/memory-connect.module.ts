import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { AppsModule } from '../apps/apps.module';
import { McpApiKeyModule } from '../mcp/mcp-api-key.module';
import { RegistrationModule } from '../registration/registration.module';
import { ManagedAppKeyGuard } from './managed-app-key.guard';
import { MemoryConnectController } from './memory-connect.controller';
import { MemoryConnectService } from './memory-connect.service';
import { MemoryConnectionModule } from './memory-connection.module';
import { MemoryExchangeClient } from './memory-exchange.client';
import { MemoryProviderResolver } from './memory-provider.resolver';
import { PendingConnectStore } from './pending-connect.store';

/**
 * Orchestration + HTTP surface for the memory-connect flow.
 *
 * Depends on AppsModule (provider/consumer resolution, availability) and the
 * leaf MemoryConnectionModule (encrypted store). AppLifecycleService (restart)
 * is reached lazily via ModuleRef in MemoryConnectService to avoid a static
 * cycle with app-lifecycle.
 */
@Module({
  imports: [MemoryConnectionModule, AppsModule, McpApiKeyModule, RegistrationModule, LoggerModule],
  controllers: [MemoryConnectController],
  providers: [MemoryProviderResolver, MemoryExchangeClient, PendingConnectStore, MemoryConnectService, ManagedAppKeyGuard],
  exports: [MemoryConnectService],
})
export class MemoryConnectModule {}
