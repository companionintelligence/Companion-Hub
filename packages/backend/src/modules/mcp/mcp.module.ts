import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpToolRegistry } from './mcp-tool-registry.service';
import { AppDiscoveryTools } from './tools/app-discovery.tools';
import { AppLifecycleTools } from './tools/app-lifecycle.tools';
import { AppConfigTools } from './tools/app-config.tools';
import { MarketplaceTools } from './tools/marketplace.tools';
import { CustomAppTools } from './tools/custom-app.tools';
import { BackupTools } from './tools/backup.tools';
import { SystemTools } from './tools/system.tools';
import { RegistrationTools } from './tools/registration.tools';
import { LinkTools } from './tools/link.tools';

@Module({
  imports: [],
  controllers: [McpController],
  providers: [
    McpService,
    McpToolRegistry,
    AppDiscoveryTools,
    AppLifecycleTools,
    AppConfigTools,
    MarketplaceTools,
    CustomAppTools,
    BackupTools,
    SystemTools,
    RegistrationTools,
    LinkTools,
  ],
  exports: [McpService],
})
export class McpModule {}
