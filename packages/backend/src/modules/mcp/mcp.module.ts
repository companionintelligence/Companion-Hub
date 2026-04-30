import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { AgentNotifyModule } from '@/modules/agent-notify/agent-notify.module';
import { AppsModule } from '@/modules/apps/apps.module';
import { DockerModule } from '@/modules/docker/docker.module';
import { AppLifecycleModule } from '@/modules/app-lifecycle/app-lifecycle.module';
import { UserConfigModule } from '@/modules/user-config/user-config.module';
import { MarketplaceModule } from '@/modules/marketplace/marketplace.module';
import { AppStoreModule } from '@/modules/app-stores/app-store.module';
import { CustomAppsModule } from '@/modules/custom-apps/custom-apps.module';
import { BackupsModule } from '@/modules/backups/backups.module';
import { SystemModule } from '@/modules/system/system.module';
import { SystemUpdateModule } from '@/modules/system-update/system-update.module';
import { RegistrationModule } from '@/modules/registration/registration.module';
import { CloudflareModule } from '@/modules/cloudflare/cloudflare.module';
import { LinksModule } from '@/modules/links/links.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpToolRegistry } from './mcp-tool-registry.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { AppDiscoveryTools } from './tools/app-discovery.tools';
import { AppLifecycleTools } from './tools/app-lifecycle.tools';
import { AppConfigTools } from './tools/app-config.tools';
import { MarketplaceTools } from './tools/marketplace.tools';
import { CustomAppTools } from './tools/custom-app.tools';
import { BackupTools } from './tools/backup.tools';
import { SystemTools } from './tools/system.tools';
import { RegistrationTools } from './tools/registration.tools';
import { LinkTools } from './tools/link.tools';
import { AppAgentTools } from './tools/app-agent.tools';
import { AppApiProxyTools } from './tools/app-api-proxy.tools';
import { AgentConfigService } from './agents/agent-config.service';
import { SkillResolverService } from './agents/skill-resolver.service';
import { OpenApiBridgeService } from './agents/openapi-bridge.service';
import { McpBridgeService } from './agents/mcp-bridge.service';
import { ApiProxyService } from './agents/api-proxy.service';
import { InferenceModule } from '@/modules/inference/inference.module';
import { InferenceTools } from './tools/inference.tools';

@Module({
  imports: [
    LoggerModule,
    AgentNotifyModule,
    AppsModule,
    DockerModule,
    AppLifecycleModule,
    UserConfigModule,
    MarketplaceModule,
    AppStoreModule,
    CustomAppsModule,
    BackupsModule,
    SystemModule,
    SystemUpdateModule,
    RegistrationModule,
    CloudflareModule,
    LinksModule,
    InferenceModule,
  ],
  controllers: [McpController],
  providers: [
    McpService,
    McpToolRegistry,
    McpAuthGuard,
    AppDiscoveryTools,
    AppLifecycleTools,
    AppConfigTools,
    MarketplaceTools,
    CustomAppTools,
    BackupTools,
    SystemTools,
    RegistrationTools,
    LinkTools,
    AppAgentTools,
    AppApiProxyTools,
    InferenceTools,
    AgentConfigService,
    SkillResolverService,
    OpenApiBridgeService,
    McpBridgeService,
    ApiProxyService,
  ],
  exports: [McpService, McpToolRegistry],
})
export class McpModule {}
