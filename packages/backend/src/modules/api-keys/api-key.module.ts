import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { ApiKeyAdminController } from './api-key-admin.controller';
import { ApiKeyAdminService } from './api-key-admin.service';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';

/**
 * Hub-wide module for API-key storage/validation (SEC-MCP-8 lineage). Kept standalone so McpModule
 * (auth guard + admin delegates), AppsModule (companion-app managed-key provisioning), and
 * MemoryConnectModule (app-callback guard) can all import it without circular dependencies — it
 * depends only on the global Database/Logger modules. ApiKeyRepository is the generic store;
 * ApiKeyService enforces per-scope access ('mcp' tools, 'app' callbacks) over it; the admin
 * controller/service power the Settings → Security "API keys" card.
 */
@Module({
  imports: [LoggerModule],
  controllers: [ApiKeyAdminController],
  providers: [ApiKeyRepository, ApiKeyService, ApiKeyAdminService],
  exports: [ApiKeyService, ApiKeyRepository, ApiKeyAdminService],
})
export class ApiKeyModule {}
