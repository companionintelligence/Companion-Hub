import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { McpService } from '../mcp.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { McpController } from '../mcp.controller';
import { McpAuthGuard } from '../mcp-auth.guard';
import { AppDiscoveryTools } from '../tools/app-discovery.tools';
import { AppLifecycleTools } from '../tools/app-lifecycle.tools';
import { AppConfigTools } from '../tools/app-config.tools';
import { MarketplaceTools } from '../tools/marketplace.tools';
import { CustomAppTools } from '../tools/custom-app.tools';
import { BackupTools } from '../tools/backup.tools';
import { SystemTools } from '../tools/system.tools';
import { RegistrationTools } from '../tools/registration.tools';
import { LinkTools } from '../tools/link.tools';
import { AppsService } from '@/modules/apps/apps.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { BackupsService } from '@/modules/backups/backups.service';
import { SystemService } from '@/modules/system/system.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { LinksService } from '@/modules/links/links.service';

describe('McpModule', () => {
  it('should compile as a standalone NestJS module without the full application', async () => {
    const module = await Test.createTestingModule({
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
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: UserConfigService, useValue: mock<UserConfigService>() },
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: AppStoreService, useValue: mock<AppStoreService>() },
        { provide: CustomAppService, useValue: mock<CustomAppService>() },
        { provide: BackupsService, useValue: mock<BackupsService>() },
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: SystemUpdateService, useValue: mock<SystemUpdateService>() },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
        { provide: LinksService, useValue: mock<LinksService>() },
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(McpService)).toBeDefined();
    expect(module.get(McpToolRegistry)).toBeDefined();
  });
});
