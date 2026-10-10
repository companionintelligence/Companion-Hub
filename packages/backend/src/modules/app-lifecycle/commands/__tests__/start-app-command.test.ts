import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { removeRestartingAppContainers, StartAppCommand, startComposeCommand } from '../start-app-command';
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
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
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

describe('StartAppCommand — pull policy', () => {
  let command: StartAppCommand;
  let dockerService: any;
  let subnetManager: ReturnType<typeof mock<SubnetManagerService>>;
  let composeArgs: string[];
  let appFilesManager: any;
  let dockerode: ReturnType<typeof mock<Dockerode>>;
  let portManager: ReturnType<typeof mock<PortManagerService>>;
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

    const subnetManagerMock = mock<SubnetManagerService>();
    subnetManager = subnetManagerMock;
    subnetManagerMock.allocateSubnet.mockResolvedValue('172.20.0.0/16');
    subnetManagerMock.releaseSubnet.mockResolvedValue(undefined);
    subnetManagerMock.listOccupiedSubnets.mockResolvedValue([
      { cidr: '10.128.10.0/24', source: 'docker', dockerNetworkName: 'chatwoot_ci-marketplace_network' },
    ]);

    const appsRepository = mock<AppsRepository>();
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      subnet: '10.128.10.0/24',
    } as any);

    dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    portManager = mock<PortManagerService>();

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === PortManagerService) return portManager;
        if (token === LoggerService) return logger;
        if (token === ConfigurationService) return config;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === AppHelpers) return appHelpers;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === MarketplaceService) return marketplaceService;
        if (token === SubnetManagerService) return subnetManagerMock;
        if (token === AppsRepository) return appsRepository;
        if (token === EnvUtils) return new EnvUtils();
        return mock();
      }),
    } as unknown as ModuleRef;

    command = new StartAppCommand(moduleRef, dockerode);
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

  it('MUST omit --pull when skipPull is true even if force_pull is true', async () => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue({
      id: 'test-app',
      force_pull: true,
    } as any);

    await command.execute(appUrn, { skipPull: true });
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).not.toContain('--pull');
  });

  it('MUST keep --force-recreate for an ordinary start, whose callers were written against it', async () => {
    await command.execute(appUrn, {});
    const upCmd = composeArgs.find((a) => a.includes('up'));
    expect(upCmd).toBe('up --detach --force-recreate --remove-orphans');
  });

  it('MUST NOT force-recreate when the Hub boot asks only for changed services (beta-max recreated ci-memory and OpenClaw on a version roll)', async () => {
    await command.execute(appUrn, { onlyRecreateChanged: true });
    const upCmd = composeArgs.find((a) => a.includes('up'));
    // Compose recreates a service only when its config hash changed; everything else keeps running.
    expect(upCmd).toBe('up --detach --remove-orphans');
  });

  it('MUST remove a restart-looping container before a boot start, which no longer force-recreates it', async () => {
    // core-2, 2026-09-17: a ci-memory service sat in `restarting`. The old boot gave it a fresh
    // container on every version change; a change-only `up` would leave it looping.
    const events: string[] = [];
    const docker = fakeDocker([
      { Id: 'loop', Names: ['/test-app-db-1'], State: 'restarting', Labels: { 'ci-hub.appurn': appUrn } },
      { Id: 'ok', Names: ['/test-app-web-1'], State: 'running', Labels: { 'ci-hub.appurn': appUrn } },
    ]);
    dockerode.listContainers.mockImplementation(docker.listContainers as any);
    dockerode.getContainer.mockImplementation(((id: string) => ({ remove: async () => events.push(`remove ${id}`) })) as any);
    dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
      events.push(args);
    });

    const result = await command.execute(appUrn, { onlyRecreateChanged: true });

    expect(result.success).toBe(true);
    expect(events).toEqual(['remove loop', 'up --detach --remove-orphans']);
  });

  it('MUST NOT look for restart-looping containers on an ordinary start, which force-recreates everything anyway', async () => {
    await command.execute(appUrn, {});

    expect(dockerode.listContainers).not.toHaveBeenCalled();
  });

  it('SHOULD still start when listing restart-looping containers fails', async () => {
    dockerode.listContainers.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));

    const result = await command.execute(appUrn, { onlyRecreateChanged: true });

    expect(result.success).toBe(true);
    expect(composeArgs).toEqual(['up --detach --remove-orphans']);
  });

  it('SHOULD remove stale networks before compose up', async () => {
    await command.execute(appUrn, {});

    expect(dockerService.removeAppNetworks).toHaveBeenCalledWith(appUrn);
  });

  it('SHOULD retry compose up after a Docker network overlap error', async () => {
    dockerService.composeApp
      .mockRejectedValueOnce(new Error('failed to create network ghost_ci-marketplace_network: networks have overlapping IPv4'))
      .mockResolvedValueOnce(undefined);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(dockerService.removeAppNetworks).toHaveBeenCalledTimes(2);
    expect(dockerService.composeApp).toHaveBeenCalledTimes(2);
  });

  it('SHOULD return a friendly network overlap error after retries are exhausted', async () => {
    dockerService.composeApp.mockRejectedValue(
      new Error('failed to create network ghost_ci-marketplace_network: networks have overlapping IPv4 10.128.10.0/24'),
    );

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('network_overlap');
    expect(result.message).toContain('network range conflict');
    expect(result.errorDetail).toContain('10.128.10.0/24');
    expect(dockerService.composeApp).toHaveBeenCalledTimes(3);
  });

  it('SHOULD not retry compose up for a Docker network name collision', async () => {
    dockerService.composeApp.mockRejectedValue(
      new Error('failed to create network ghost_ci-marketplace_network: network with name ghost_ci-marketplace_network already exists'),
    );

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(dockerService.composeApp).toHaveBeenCalledTimes(1);
    expect(subnetManager.releaseSubnet).not.toHaveBeenCalled();
  });

  // A device present at install time can be gone by a later start (ROCm/KVM modules not yet
  // loaded at boot, host reconfigured) — start needs the same host-device preflight as install,
  // rather than only finding out via Docker's raw compose-up error.
  it('SHOULD fail fast before compose up when /dev/kfd is required but missing', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('rocm_kfd_missing');
    expect(result.message).toContain('Set up ROCm in AI Settings');
    expect(dockerService.composeApp).not.toHaveBeenCalled();
  });

  it('SHOULD start normally when the required host device is available', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(true);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result.success).toBe(true);
    expect(isRocmKfdPassthroughAvailable).toHaveBeenCalled();
    expect(dockerService.composeApp).toHaveBeenCalled();
  });

  /*
   * A custom app made before custom apps got a host port of their own has none on its row, so its env
   * fell back to the internal port and the host published that: port 80 never started.
   */
  describe('a custom app with no host port yet', () => {
    const customUrn = 'my-nginx:_user' as AppUrn;
    const helperOf = <T>(token: unknown) => (command as unknown as { moduleRef: { get: (t: unknown) => T } }).moduleRef.get(token);

    beforeEach(() => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 80, force_pull: false } as any);
      portManager.getMainPort.mockResolvedValue(null);
      portManager.allocatePorts.mockResolvedValue([
        { id: 9, appUrn: customUrn, hostPort: 10000, containerPort: 80, protocol: 'tcp', label: 'main', createdAt: '2026-10-10T00:00:00.000Z' },
      ]);
      helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).getAppByUrn.mockResolvedValue({
        id: 7,
        config: { exposureMode: 'local' },
      } as any);
    });

    it('gets one on its first start, writes it to the row, and builds its env on it', async () => {
      const result = await command.execute(customUrn, {});

      expect(result.success).toBe(true);
      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 80, label: 'main', preferredHostPort: 80 }]);
      expect(helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).updateAppById).toHaveBeenCalledWith(7, {
        config: { exposureMode: 'local', port: 10000 },
        port: 10000,
      });
      expect(helperOf<ReturnType<typeof mock<AppHelpers>>>(AppHelpers).generateEnvFile).toHaveBeenCalledWith(
        customUrn,
        expect.objectContaining({ port: 10000 }),
      );
    });

    it('keeps the host port a custom app already has', async () => {
      await command.execute(customUrn, { port: 18080 });

      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(helperOf<ReturnType<typeof mock<AppHelpers>>>(AppHelpers).generateEnvFile).toHaveBeenCalledWith(
        customUrn,
        expect.objectContaining({ port: 18080 }),
      );
    });

    it('leaves a store app to the port its install allocated', async () => {
      await command.execute('wordpress:ci-marketplace' as AppUrn, {});

      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(portManager.getMainPort).not.toHaveBeenCalled();
    });
  });
});

type FakeContainer = { Id: string; Names: string[]; State: string; Labels: Record<string, string> };

/** Answers `listContainers` the way the daemon does: every label filter and one of the status filters must match. */
function fakeDocker(containers: FakeContainer[]) {
  const removed: string[] = [];
  return {
    removed,
    listContainers: async (options: { filters: { label: string[]; status: string[] } }) =>
      containers.filter(
        (container) =>
          options.filters.label.every((pair) => {
            const [key, ...value] = pair.split('=');
            return container.Labels[key] === value.join('=');
          }) && options.filters.status.includes(container.State),
      ),
    getContainer: (id: string) => ({
      remove: async () => {
        removed.push(id);
      },
    }),
  };
}

describe('removeRestartingAppContainers', () => {
  const appUrn = 'ci-memory:ci-marketplace' as AppUrn;

  it("removes only this app's restart-looping containers, under the current or the retired label", async () => {
    const docker = fakeDocker([
      { Id: 'new-loop', Names: ['/ci-memory_ci-marketplace-api-1'], State: 'restarting', Labels: { 'ci-hub.appurn': appUrn } },
      // core-2's app containers predate the rename and carry only the ci-os-hub labels.
      { Id: 'legacy-loop', Names: ['/ci-memory_ci-marketplace-database-1'], State: 'restarting', Labels: { 'ci-os-hub.appurn': appUrn } },
      {
        Id: 'both-labels',
        Names: ['/ci-memory_ci-marketplace-gateway-1'],
        State: 'restarting',
        Labels: { 'ci-hub.appurn': appUrn, 'ci-os-hub.appurn': appUrn },
      },
      { Id: 'healthy', Names: ['/ci-memory_ci-marketplace-summary-service-1'], State: 'running', Labels: { 'ci-hub.appurn': appUrn } },
      {
        Id: 'other-app',
        Names: ['/ci-openclaw_ci-marketplace-ci-openclaw-1'],
        State: 'restarting',
        Labels: { 'ci-hub.appurn': 'ci-openclaw:ci-marketplace' },
      },
    ]);

    const removed = await removeRestartingAppContainers(docker as unknown as Dockerode, appUrn);

    expect(docker.removed).toEqual(['new-loop', 'both-labels', 'legacy-loop']);
    expect(removed).toEqual(['ci-memory_ci-marketplace-api-1', 'ci-memory_ci-marketplace-gateway-1', 'ci-memory_ci-marketplace-database-1']);
  });
});

describe('startComposeCommand', () => {
  it('keeps --pull always independent of the recreate mode, so a boot reconcile still honours force_pull', () => {
    expect(startComposeCommand({ forcePull: true, onlyRecreateChanged: true })).toBe('up --detach --remove-orphans --pull always');
    expect(startComposeCommand({ forcePull: true })).toBe('up --detach --force-recreate --remove-orphans --pull always');
  });

  it('never emits empty arguments, which compose would reject as a service name', () => {
    for (const command of [startComposeCommand({ forcePull: false }), startComposeCommand({ forcePull: false, onlyRecreateChanged: true })]) {
      expect(command.split(' ')).not.toContain('');
    }
  });
});
