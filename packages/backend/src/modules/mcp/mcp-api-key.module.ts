import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { McpApiKeyRepository } from './mcp-api-key.repository';
import { McpApiKeyService } from './mcp-api-key.service';

/**
 * SEC-MCP-8: standalone module for MCP API-key storage/validation. Kept separate from McpModule so
 * both McpModule (auth guard + admin surface) and AppsModule (companion-app managed-key provisioning)
 * can import it without a circular dependency — it depends only on the global Database/Logger modules.
 */
@Module({
  imports: [LoggerModule],
  providers: [McpApiKeyRepository, McpApiKeyService],
  exports: [McpApiKeyService],
})
export class McpApiKeyModule {}
