import { Module } from '@nestjs/common';
import { AppFilesManager } from './app-files-manager';
import { AppsRepository } from './apps.repository';

/**
 * DB + installed-files accessors with no Marketplace/Docker imports.
 * Used by Docker compose-arg paths to avoid Docker ↔ Marketplace import cycles.
 */
@Module({
  providers: [AppFilesManager, AppsRepository],
  exports: [AppFilesManager, AppsRepository],
})
export class AppsDataModule {}
