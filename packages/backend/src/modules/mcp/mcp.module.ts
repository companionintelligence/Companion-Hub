import { Module, forwardRef } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { EnvModule } from '@/modules/env/env.module';
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
import { ApiKeyModule } from '../api-keys/api-key.module';
import { McpController } from './mcp.controller';
import { McpAdminController } from './mcp-admin.controller';
import { McpAppsController } from './mcp-apps.controller';
import { McpService } from './mcp.service';
import { McpServerFactory } from './mcp-server.factory';
import { McpV2ServerFactory } from './mcp-v2-server.factory';
import { McpModernHandlerService } from './mcp-modern-handler.service';
import { McpSessionRegistry } from './mcp-session.registry';
import { McpAdminService } from './mcp-admin.service';
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
import { OperationsTools } from './tools/operations.tools';
import { AgentConfigService } from './agents/agent-config.service';
import { SkillResolverService } from './agents/skill-resolver.service';
import { OpenApiBridgeService } from './agents/openapi-bridge.service';
import { McpBridgeService } from './agents/mcp-bridge.service';
import { ApiProxyService } from './agents/api-proxy.service';
import { McpProbeService } from './mcp-probe.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { InferenceModule } from '@/modules/inference/inference.module';
import { InferenceTools } from './tools/inference.tools';
import { PortalModule } from '@/core/portal/portal.module';

// ISSUE-MCP-2: rate-limit the MCP endpoint so a runaway or hostile client can't flood the Hub with
// tool calls. Applied via ThrottlerGuard on the controller. Tunable via env; defaults suit a chatty
// but well-behaved agent (many tools/list + tools/call per session).
const MCP_RATE_TTL_MS = Number(process.env.MCP_RATE_TTL_MS) || 60_000;
const MCP_RATE_LIMIT = Number(process.env.MCP_RATE_LIMIT) || 300;

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: MCP_RATE_TTL_MS, limit: MCP_RATE_LIMIT }]),
    LoggerModule,
    EnvModule,
    AgentNotifyModule,
    forwardRef(() => AppsModule),
    forwardRef(() => DockerModule),
    forwardRef(() => AppLifecycleModule),
    forwardRef(() => UserConfigModule),
    MarketplaceModule,
    AppStoreModule,
    forwardRef(() => CustomAppsModule),
    forwardRef(() => BackupsModule),
    SystemModule,
    SystemUpdateModule,
    forwardRef(() => RegistrationModule),
    forwardRef(() => CloudflareModule),
    LinksModule,
    InferenceModule,
    ApiKeyModule,
    // MarketplaceWhoIsService: the admin tool runner names the signed-in person to the lifecycle tools.
    PortalModule,
  ],
  controllers: [McpController, McpAdminController, McpAppsController],
  providers: [
    McpService,
    McpServerFactory,
    McpV2ServerFactory,
    McpModernHandlerService,
    McpSessionRegistry,
    McpAdminService,
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
    OperationsTools,
    InferenceTools,
    AgentConfigService,
    SkillResolverService,
    OpenApiBridgeService,
    McpBridgeService,
    ApiProxyService,
    McpProbeService,
  ],
  exports: [McpService, McpToolRegistry, McpProbeService, McpBridgeService, AgentConfigService],
})
export class McpModule {}
