import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { ApiKeyRepository } from './api-key.repository';
import { McpApiKeyService } from './mcp-api-key.service';

/**
 * SEC-MCP-8: standalone module for API-key storage/validation. Kept separate from McpModule so both
 * McpModule (auth guard + admin surface) and AppsModule (companion-app managed-key provisioning) can
 * import it without a circular dependency — it depends only on the global Database/Logger modules.
 * ApiKeyRepository is the generic (audience-aware) store; McpApiKeyService is the 'mcp'-scoped facade.
 * A future REST-key service would join here, reusing the same repository + table.
 */
@Module({
  imports: [LoggerModule],
  providers: [ApiKeyRepository, McpApiKeyService],
  exports: [McpApiKeyService, ApiKeyRepository],
})
export class McpApiKeyModule {}
