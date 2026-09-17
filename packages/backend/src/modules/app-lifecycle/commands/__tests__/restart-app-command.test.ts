import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { RestartAppCommand } from '../restart-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { TranslatableError } from '@/common/error/translatable-error';
import { HttpStatus } from '@nestjs/common';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppUrn } from '@ci-hub/common/types';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import fs from 'node:fs';

vi.mock('node:fs', async () => ({
  default: {
    constants: {
      F_OK: 0,
      R_OK: 4,
    },
    promises: {
      mkdir: vi.fn(),
      chmod: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn().mockResolvedValue(''),
      access: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

vi.mock('@/modules/inference/host-rocm-availability', () => ({
  isRocmKfdPassthroughAvailable: vi.fn().mockResolvedValue(true),
}));

describe('RestartAppCommand — pull policy', () => {
  let command: RestartAppCommand;
  let dockerService: any;
  let composeArgs: string[];
  let appFilesManager: any;
  let entitlements: ReturnType<typeof mock<MarketplaceEntitlementService>>;
  const appUrn = 'urn:store:test-app' as AppUrn;

  beforeEach(() => {
    vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValue(true);
    vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);

    composeArgs = [];
    dockerService = {
      composeApp: vi.fn(async (_urn: string, args: string) => {
        composeArgs.push(args);
      }),
      removeAppNetworks: vi.fn().mockResolvedValue(undefined),
    };

    const logger = mockDeep<LoggerService>();
    const config = mock<ConfigurationService>();
    // @ts-expect-error
    config.get.mockImplementation((key: string) => {
      if (key === 'directories') return { dataDir: '/tmp', appDataDir: '/tmp/app-data' };
      if (key === 'architecture') return 'amd64';
      if (key === 'userSettings') return { domain: 'test.local', localDomain: 'local' };
      return {};
    });

    appFilesManager = mock<AppFilesManager>();
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: false,
    } as any);
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: '{}', path: '/tmp' });
    appFilesManager.getUserComposeFile.mockResolvedValue({ content: null, path: '/tmp/user-compose.yml' } as any);
    appFilesManager.getAppEnv.mockResolvedValue({ content: '', path: '/tmp/.env' });
    appFilesManager.setAppDataDirPermissions.mockResolvedValue();
    appFilesManager.writeDockerComposeYml.mockResolvedValue();

    const appHelpers = mock<AppHelpers>();
    appHelpers.generateEnvFile.mockResolvedValue();

    const traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.regenerateTraefikConfig.mockResolvedValue();

    const marketplaceService = mock<MarketplaceService>();
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();

    entitlements = mock<MarketplaceEntitlementService>();
    entitlements.assertForStart.mockResolvedValue(undefined);

    const subnetManager = mock<SubnetManagerService>();
    subnetManager.allocateSubnet.mockResolvedValue('172.20.0.0/16');
    subnetManager.releaseSubnet.mockResolvedValue(undefined);

    const dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === LoggerService) return logger;
        if (token === ConfigurationService) return config;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === AppHelpers) return appHelpers;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === MarketplaceService) return marketplaceService;
        if (token === SubnetManagerService) return subnetManager;
        if (token === EnvUtils) return new EnvUtils();
        if (token === MarketplaceEntitlementService) return entitlements;
        return mock();
      }),
    } as unknown as ModuleRef;

    command = new RestartAppCommand(moduleRef, dockerode);
  });

  it('MUST NOT include --pull never in compose args', async () => {
    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull never');
  });

  it('MUST omit --pull flag when force_pull is false', async () => {
    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull');
  });

  it('MUST include --pull always when force_pull is true', async () => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: true,
    } as any);

    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).toContain('--pull always');
  });

  // A device present at install time can be gone by a later restart (ROCm/KVM modules not yet
  // loaded at boot, host reconfigured) — restart needs the same host-device preflight as
  // install/start, rather than only finding out via Docker's raw compose-up error.
  it('SHOULD fail fast before compose down/up when /dev/kfd is required but missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect((result as any).errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
    expect(dockerService.composeApp).not.toHaveBeenCalled();
  });

  // Restart is `down` then `up --force-recreate`. Ungated, an app Start refused for a lapsed
  // entitlement came straight back through Restart.
  it('checks the same entitlement policy as Start', async () => {
    await command.execute(appUrn, {});

    expect(entitlements.assertForStart).toHaveBeenCalledWith(appUrn);
  });

  it('leaves a running app running when the entitlement refuses the restart', async () => {
    entitlements.assertForStart.mockRejectedValue(
      new TranslatableError('APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED', {}, HttpStatus.PAYMENT_REQUIRED),
    );

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    // Refused before `down`: stopping first and then refusing `up` would turn a refusal into an outage.
    expect(dockerService.composeApp).not.toHaveBeenCalled();
  });
});
