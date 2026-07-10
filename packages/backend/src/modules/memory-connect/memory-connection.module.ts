import { Module } from '@nestjs/common';
import { EncryptionModule } from '@/core/encryption/encryption.module';
import { LoggerModule } from '@/core/logger/logger.module';
import { MemoryConnectionRepository } from './memory-connection.repository';
import { MemoryConnectionService } from './memory-connection.service';

/**
 * Leaf module owning the durable, encrypted memory-connection store.
 *
 * Kept deliberately dependency-light (only the global Database/Logger modules +
 * EncryptionModule) so that both AppsModule (env generation reads stored creds)
 * and the orchestration MemoryConnectModule can import it without a circular
 * dependency — the same split McpApiKeyModule uses for the api-key store.
 */
@Module({
  imports: [EncryptionModule, LoggerModule],
  providers: [MemoryConnectionRepository, MemoryConnectionService],
  exports: [MemoryConnectionService],
})
export class MemoryConnectionModule {}
