import { Module } from '@nestjs/common';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { PortAllocationRepository } from '../network/port-allocation.repository';
import { AppsDataModule } from './apps-data.module';
import { AppsReadService } from './apps-read.service';
import { InstallPipelineTracker } from './install-pipeline.tracker';

/**
 * Read-only apps surface. Imports {@link AppsDataModule} (no Docker) + Marketplace.
 */
@Module({
  imports: [AppsDataModule, MarketplaceModule],
  providers: [AppsReadService, PortAllocationRepository, InstallPipelineTracker],
  exports: [AppsDataModule, AppsReadService, PortAllocationRepository, InstallPipelineTracker],
})
export class AppsReadModule {}
