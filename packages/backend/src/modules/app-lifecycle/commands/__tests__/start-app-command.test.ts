import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { removeRestartingAppContainers, StartAppCommand, startComposeCommand } from '../start-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN, type AppContainerLook } from '@/modules/docker/managed-app-containers';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import type { AppUrn } from '@ci-hub/common/types';
import { PORT_EXPOSE_KIND, parseComposeJson } from '@ci-hub/common/schemas';
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

// An installed compose is read with parseInstalledComposeJson: one stub stands for both parses.
vi.mock('@ci-hub/common/schemas', async (importOriginal) => {
  const parse = vi.fn().mockReturnValue({ services: [], overrides: [] });
  return { ...((await importOriginal()) as any), parseComposeJson: parse, parseInstalledComposeJson: parse };
});

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
  let dockerReadFacade: ReturnType<typeof mock<DockerReadFacade>>;
  let portManager: ReturnType<typeof mock<PortManagerService>>;
  let traefikConfigService: ReturnType<typeof mock<TraefikConfigService>>;
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
      waitForManagedAppContainersReady: vi.fn().mockResolvedValue({ ok: true, message: 'All containers came up' }),
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

    traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.regenerateTraefikConfig.mockResolvedValue();

    const marketplaceService = mock<MarketplaceService>();

    marketplaceService.listedAppUrns.mockResolvedValue([]);
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();

    const subnetManagerMock = mock<SubnetManagerService>();
    subnetManager = subnetManagerMock;
    subnetManagerMock.allocateSubnet.mockResolvedValue('172.20.0.0/16');
    subnetManagerMock.releaseSubnet.mockResolvedValue(undefined);
    subnetManagerMock.listOccupiedSubnets.mockResolvedValue([
      { cidr: '10.128.10.0/24', source: 'docker', dockerNetworkName: 'chatwoot_ci-marketplace_network' },
    ]);

    const appsRepository = mock<AppsRepository>();

    appsRepository.getApps.mockResolvedValue([]);
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      subnet: '10.128.10.0/24',
    } as any);

    dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    portManager = mock<PortManagerService>();

    dockerReadFacade = mock<DockerReadFacade>();
    dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([]);
    dockerReadFacade.describeAppCameUpFailure.mockResolvedValue({ ok: false, message: 'db keeps restarting', errorDetail: 'db (restarting)' });

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === DockerReadFacade) return dockerReadFacade;
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

  // CI-Hub#2376: the refusal touches no container, so a start sent to an app that is up leaves it up.
  it('reports a host-device refusal as rolled back, since no container was touched', async () => {
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [{ name: 'comfyui', image: 'docker.io/example/comfyui:latest', devices: ['/dev/dri:/dev/dri', '/dev/kfd:/dev/kfd'] }],
      overrides: [],
    } as any);
    vi.mocked(isRocmKfdPassthroughAvailable).mockResolvedValueOnce(false);

    const result = await command.execute('comfyui:store' as AppUrn, {});

    expect(result).toMatchObject({ success: false, errorCode: 'rocm_kfd_missing', rolledBack: true });
  });

  it('does not report a failed compose up as rolled back', async () => {
    dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
      composeArgs.push(args);
      if (args.startsWith('up')) throw new Error('compose up failed');
    });

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('rolledBack');
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
      // The Hub's web ports come from the env, so a developer's own HTTP_PORT must not leak in.
      vi.stubEnv('HTTP_PORT', '');
      vi.stubEnv('HTTPS_PORT', '');
      vi.stubEnv('TRAEFIK_DASHBOARD_PORT', '');
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 80, force_pull: false } as any);
      portManager.getMainPort.mockResolvedValue(null);
      portManager.getAllAllocations.mockResolvedValue([]);
      portManager.migrateExistingApp.mockResolvedValue();
      portManager.releaseAll.mockResolvedValue(1);
      portManager.allocatePorts.mockResolvedValue([
        { id: 9, appUrn: customUrn, hostPort: 10000, containerPort: 80, protocol: 'tcp', label: 'main', createdAt: '2026-10-10T00:00:00.000Z' },
      ]);
      helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).getAppsByPort.mockResolvedValue([]);
      helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).getAppByUrn.mockResolvedValue({
        id: 7,
        config: { exposureMode: 'local' },
      } as any);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('gets one on its first start, writes it to the row, and builds its env on it', async () => {
      const result = await command.execute(customUrn, {});

      expect(result.success).toBe(true);
      // 80 is the Hub's own HTTP port, so the app can't keep it and it is not even asked for.
      expect(portManager.migrateExistingApp).not.toHaveBeenCalled();
      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 80, label: 'main', preferredHostPort: undefined }]);
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
      portManager.getMainPort.mockResolvedValue(18080);

      await command.execute(customUrn, { port: 18080 });

      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(portManager.migrateExistingApp).not.toHaveBeenCalled();
      expect(helperOf<ReturnType<typeof mock<AppHelpers>>>(AppHelpers).generateEnvFile).toHaveBeenCalledWith(
        customUrn,
        expect.objectContaining({ port: 18080 }),
      );
    });

    it("keeps it off the host port the desktop app moved the Hub's HTTPS to", async () => {
      vi.stubEnv('HTTPS_PORT', '8443');
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 8443, force_pull: false } as any);

      await command.execute(customUrn, {});

      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 8443, label: 'main', preferredHostPort: undefined }]);
    });

    /*
     * The settings dialog fills its port field from config.json, which holds a custom app's internal
     * port, so a save stored 8080 on the row (80 can't be saved: the form takes 1024 and up). The boot
     * backfill then recorded 8080 as the app's main allocation, and Traefik's dashboard holds it.
     */
    it('replaces a Hub port a settings save stored, and the allocation the boot backfill made of it', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 8080, force_pull: false } as any);
      portManager.getMainPort.mockResolvedValue(8080);

      const result = await command.execute(customUrn, { port: 8080 });

      expect(result.success).toBe(true);
      expect(portManager.releaseAll).toHaveBeenCalledWith(customUrn);
      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 8080, label: 'main', preferredHostPort: undefined }]);
      expect(helperOf<ReturnType<typeof mock<AppHelpers>>>(AppHelpers).generateEnvFile).toHaveBeenCalledWith(
        customUrn,
        expect.objectContaining({ port: 10000 }),
      );
    });

    it('says so when it moves the app off the Hub port it was saved on', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 80, force_pull: false } as any);
      portManager.getMainPort.mockResolvedValue(8080);

      const result = await command.execute(customUrn, { port: 8080 });

      expect(result).toMatchObject({ success: true, movedHostPort: { from: 8080, to: 10000 } });
    });

    it('reports no move for an app given its first host port', async () => {
      const result = (await command.execute(customUrn, {})) as { movedHostPort?: unknown };

      expect(result.success).toBe(true);
      expect(result.movedHostPort).toBeUndefined();
    });

    it('keeps the port a settings save stored when nothing else holds it, and records it', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 8081, force_pull: false } as any);

      await command.execute(customUrn, { port: 8081 });

      expect(portManager.migrateExistingApp).toHaveBeenCalledWith(customUrn, 8081, 8081);
      expect(portManager.allocatePorts).not.toHaveBeenCalled();
    });

    /*
     * An app made before this change keeps the port it published unless the Hub or another app holds it,
     * and that port is recorded the way the boot backfill records an old install's. 3000 is on the port
     * manager's reserved list (the Hub's development port), but a running Hub doesn't publish it.
     */
    it('keeps the port an older app published on 3000, which nothing holds, and records it', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-grafana', port: 3000, force_pull: false } as any);

      await command.execute(customUrn, {});

      expect(portManager.migrateExistingApp).toHaveBeenCalledWith(customUrn, 3000, 3000);
      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).updateAppById).toHaveBeenCalledWith(7, {
        config: { exposureMode: 'local', port: 3000 },
        port: 3000,
      });
      expect(helperOf<ReturnType<typeof mock<AppHelpers>>>(AppHelpers).generateEnvFile).toHaveBeenCalledWith(
        customUrn,
        expect.objectContaining({ port: 3000 }),
      );
    });

    it('moves an older app off a port another app was given', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-grafana', port: 3000, force_pull: false } as any);
      portManager.getAllAllocations.mockResolvedValue([
        {
          id: 2,
          appUrn: 'grafana:ci-marketplace',
          hostPort: 3000,
          containerPort: 3000,
          protocol: 'tcp',
          label: 'main',
          createdAt: '2026-10-10T00:00:00.000Z',
        },
      ]);

      await command.execute(customUrn, {});

      expect(portManager.migrateExistingApp).not.toHaveBeenCalled();
      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 3000, label: 'main', preferredHostPort: undefined }]);
    });

    it("moves an older app off a port another app's row publishes", async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-grafana', port: 3000, force_pull: false } as any);
      helperOf<ReturnType<typeof mock<AppsRepository>>>(AppsRepository).getAppsByPort.mockImplementation(
        async (port: number) => (port === 3000 ? [{ appName: 'grafana-host', appStoreSlug: '_user' }] : []) as any,
      );

      await command.execute(customUrn, {});

      expect(portManager.migrateExistingApp).not.toHaveBeenCalled();
      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 3000, label: 'main', preferredHostPort: undefined }]);
    });

    it('keeps it off a host port its own Port Mappings publish', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'my-nginx', port: 9200, force_pull: false } as any);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/tmp',
        content: {
          services: [{ name: 'web', image: 'nginx', isMain: true, internalPort: 9200, addPorts: [{ containerPort: 9300, hostPort: 9200 }] }],
        },
      });

      await command.execute(customUrn, {});

      expect(portManager.allocatePorts).toHaveBeenCalledWith(customUrn, [{ containerPort: 9200, label: 'main', preferredHostPort: undefined }]);
    });

    it('still starts on what it published before when no host port can be allocated', async () => {
      portManager.allocatePorts.mockRejectedValue(new Error('NETWORK_ERROR_NO_AVAILABLE_PORTS'));

      const result = await command.execute(customUrn, {});

      expect(portManager.allocatePorts).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(dockerService.composeApp).toHaveBeenCalled();
    });

    it('leaves a store app to the port its install allocated', async () => {
      await command.execute('wordpress:ci-marketplace' as AppUrn, {});

      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(portManager.getMainPort).not.toHaveBeenCalled();
    });
  });

  describe('the record of the images the start pulled', () => {
    const whoami = 'traefik/whoami:v1.10.2';
    let onComputer: Map<string, string>;

    beforeEach(() => {
      onComputer = new Map();
      vi.mocked(parseComposeJson).mockReturnValue({
        services: [{ name: 'web', image: whoami, isMain: true, internalPort: 80 }],
        overrides: [],
      } as any);
      dockerService.imageIdLocally = vi.fn(async (ref: string) => onComputer.get(ref) ?? null);
      dockerService.imageIdsLocally = vi.fn(async () => new Set(onComputer.values()));
      dockerService.imageTagsLocally = vi.fn(async () => []);
      appFilesManager.readPulledImages.mockResolvedValue({ imageIds: [], imageTags: [] });
      appFilesManager.addPulledImages.mockResolvedValue(true);
    });

    it('lists the images here for a forced pull, which can move a tag, and not for a start that pulls nothing', async () => {
      onComputer.set(whoami, 'sha256:whoami');
      appFilesManager.readPulledImages.mockResolvedValue({ imageIds: ['sha256:whoami'], imageTags: [] });

      await command.execute(appUrn, {});
      expect(dockerService.imageIdsLocally).not.toHaveBeenCalled();

      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'test-app', force_pull: true } as any);
      await command.execute(appUrn, {});
      expect(dockerService.imageIdsLocally).toHaveBeenCalledTimes(1);
    });

    it('records an image compose pulled during the start', async () => {
      dockerService.composeApp.mockImplementation(async () => {
        onComputer.set(whoami, 'sha256:whoami');
      });

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      expect(appFilesManager.addPulledImages).toHaveBeenCalledWith(appUrn, { imageIds: ['sha256:whoami'], imageTags: [] });
    });

    it('does not record an image that was on the computer before the start', async () => {
      onComputer.set(whoami, 'sha256:mine');

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      expect(appFilesManager.addPulledImages).not.toHaveBeenCalled();
    });

    it('does not fail the start when the record cannot be written', async () => {
      appFilesManager.addPulledImages.mockResolvedValue(false);
      dockerService.composeApp.mockImplementation(async () => {
        onComputer.set(whoami, 'sha256:whoami');
      });

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
    });
  });

  describe('after compose up', () => {
    const crashLoop = {
      ok: false,
      message: 'summary-service keeps restarting (exit 126): permission denied',
      errorDetail: 'app-summary-service-1 (restarting, exit 126): permission denied',
      serviceFailure: { kind: 'restarting', service: 'summary-service', exitCode: 126, logLine: 'permission denied' },
    };

    it('does not report success while a service crash-loops and says which one and why', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({
        success: false,
        message: 'summary-service keeps restarting (exit 126): permission denied',
        errorCode: 'app_service_failed',
        errorDetail: crashLoop.errorDetail,
        serviceFailure: crashLoop.serviceFailure,
      });
    });

    it('leaves the other containers up when a service fails', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      await command.execute(appUrn, {});

      expect(composeArgs.some((args) => args.startsWith('down') || args.startsWith('stop'))).toBe(false);
    });

    describe('when someone asked for this start', () => {
      it('takes the containers down, so Stopped is true and Docker stops retrying', async () => {
        dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result).toMatchObject({ success: false, serviceFailure: crashLoop.serviceFailure });
        expect(composeArgs).toContain('down --remove-orphans');
      });

      it('rebuilds the routes after the containers are gone', async () => {
        const order: string[] = [];
        dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);
        dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
          order.push(args.split(' ')[0] ?? args);
        });
        traefikConfigService.regenerateTraefikConfig.mockImplementation(async () => {
          order.push('traefik');
        });

        await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

        expect(order).toEqual(['up', 'down', 'traefik']);
      });

      it('still reports the failed service when the routes cannot be rebuilt', async () => {
        dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);
        traefikConfigService.regenerateTraefikConfig.mockRejectedValue(new Error('traefik config is locked'));

        const result = await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

        expect(result).toMatchObject({ success: false, serviceFailure: crashLoop.serviceFailure });
      });

      it('still reports the failure when the containers cannot be taken down', async () => {
        dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);
        dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
          if (args.startsWith('down')) throw new Error('daemon is busy');
        });

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result).toMatchObject({ success: false, serviceFailure: crashLoop.serviceFailure });
      });

      it('does not touch an app that came up', async () => {
        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(true);
        expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
      });

      it('gives a slow app the longer window before calling it failed', async () => {
        await command.execute(appUrn, { stopIfNotUp: true });

        expect(dockerService.waitForManagedAppContainersReady).toHaveBeenCalledWith(appUrn, APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN);
      });

      it('does not touch the app when Docker could not answer the check', async () => {
        dockerService.waitForManagedAppContainersReady.mockRejectedValue(new Error('socket hang up'));

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(true);
        expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
      });
    });

    describe('when compose up itself fails', () => {
      const dependencyFailed = new Error('dependency failed to start: container test-app-db-1 is unhealthy');
      const dbLook = (over: Partial<AppContainerLook>): AppContainerLook[] => [
        {
          id: 'db',
          service: 'db',
          containerName: 'test-app-db-1',
          state: 'running',
          exitCode: 0,
          restartCount: 0,
          startedAtMs: null,
          health: null,
          ...over,
        },
      ];
      const restartingDb = dbLook({ state: 'restarting', exitCode: 1, restartCount: 4 });

      beforeEach(() => {
        dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
          composeArgs.push(args);
          if (args.startsWith('up')) throw dependencyFailed;
        });
      });

      it('takes the app down when someone asked for the start and a container is left restarting', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(restartingDb);

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(composeArgs.at(-1)).toBe('down --remove-orphans');
      });

      it('takes the app down when the dependency is left running with its health check failing', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(dbLook({ health: 'unhealthy' }));

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(composeArgs.at(-1)).toBe('down --remove-orphans');
      });

      it('takes the app down when the look lands between two crashes of the dependency', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(dbLook({ health: 'starting', restartCount: 3 }));

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(composeArgs.at(-1)).toBe('down --remove-orphans');
      });

      describe('when a setup step the app waits on to finish failed', () => {
        const setupStepFailed = new Error('service "migrate" didn\'t complete successfully: exit 1');
        const look = (service: string, over: Partial<AppContainerLook>): AppContainerLook => ({
          ...dbLook({})[0],
          id: service,
          service,
          containerName: `test-app-${service}-1`,
          ...over,
        });
        const setupStepLeft = [
          look('db', { health: 'healthy' }),
          look('migrate', { state: 'exited', exitCode: 1 }),
          look('web', { state: 'created', exitCode: 0 }),
        ];

        beforeEach(() => {
          dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
            composeArgs.push(args);
            if (args.startsWith('up')) throw setupStepFailed;
          });
        });

        it('takes the app down, so the database that started does not run on behind Stopped', async () => {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(setupStepLeft);

          const result = await command.execute(appUrn, { stopIfNotUp: true });

          expect(result.success).toBe(false);
          expect(result.message).toContain("didn't complete successfully");
          expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
        });

        it('keeps the end of the failed setup step log before the container goes', async () => {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(setupStepLeft);

          await command.execute(appUrn, { stopIfNotUp: true });

          expect(dockerReadFacade.describeAppCameUpFailure).toHaveBeenCalledWith(
            expect.objectContaining({ containers: [expect.objectContaining({ service: 'migrate', exitCode: 1 })] }),
          );
        });

        it('leaves the containers to Docker for the Hub own start', async () => {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(setupStepLeft);

          const result = await command.execute(appUrn, {});

          expect(result.success).toBe(false);
          expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
        });

        it('takes nothing down after a failed pull, which leaves no containers', async () => {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([]);

          await command.execute(appUrn, { stopIfNotUp: true });

          expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
        });

        it('takes nothing down for a one-shot that failed when nothing waits on it', async () => {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([look('db', {}), look('migrate', { state: 'exited', exitCode: 1 })]);

          await command.execute(appUrn, { stopIfNotUp: true });

          expect(dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
        });
      });

      it('keeps the end of the failing container log before the container goes', async () => {
        const order: string[] = [];
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(restartingDb);
        dockerReadFacade.describeAppCameUpFailure.mockImplementation(async () => {
          order.push('logs');
          return { ok: false, message: 'db keeps restarting', errorDetail: 'db (restarting)' };
        });
        dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
          order.push(args.split(' ')[0] ?? args);
          if (args.startsWith('up')) throw dependencyFailed;
        });

        await command.execute(appUrn, { stopIfNotUp: true });

        expect(order).toEqual(['up', 'logs', 'down']);
      });

      it('rebuilds the routes after taking the app down', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(restartingDb);

        await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

        expect(traefikConfigService.regenerateTraefikConfig).toHaveBeenCalledWith(0);
      });

      it('still reports the compose failure when the routes cannot be rebuilt', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(restartingDb);
        traefikConfigService.regenerateTraefikConfig.mockRejectedValue(new Error('traefik config is locked'));

        const result = await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(result.message).toContain('dependency failed to start');
      });

      it('still reports the compose failure when Docker cannot be asked about the containers', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockRejectedValue(new Error('socket hang up'));

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.message).toContain('dependency failed to start');
        expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
      });

      it('leaves the routes alone when nothing was taken down', async () => {
        await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

        expect(traefikConfigService.regenerateTraefikConfig).not.toHaveBeenCalled();
      });

      it('takes nothing down for a service that crashed long ago and has been up since', async () => {
        for (const health of ['healthy', null]) {
          dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(dbLook({ restartCount: 5, health }));
          composeArgs.length = 0;

          await command.execute(appUrn, { stopIfNotUp: true });

          expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
        }
      });

      it('takes nothing down when no container is failing, as after a failed pull', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(dbLook({}));

        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
      });

      it('leaves a restarting container to Docker for the Hub own start', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue(restartingDb);

        const result = await command.execute(appUrn, {});

        expect(result.success).toBe(false);
        expect(composeArgs.some((args) => args.startsWith('down'))).toBe(false);
      });
    });

    it('still routes an exposed app when a service fails, since its other containers go on serving', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      await command.execute(appUrn, { exposedLocal: true });

      expect(traefikConfigService.regenerateTraefikConfig).toHaveBeenCalled();
    });

    it('reports success when the containers came up', async () => {
      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: true, message: `App ${appUrn} started successfully` });
      expect(dockerService.waitForManagedAppContainersReady).toHaveBeenCalledWith(appUrn, undefined);
    });

    it('checks an unchanged boot start too', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      const result = await command.execute(appUrn, { onlyRecreateChanged: true });

      expect(result.success).toBe(false);
    });

    it('does not fail a start because Docker could not answer the check', async () => {
      dockerService.waitForManagedAppContainersReady.mockRejectedValue(new Error('socket hang up'));

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
    });

    it('never checks a port-expose workload, which has no containers', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'test-app', kind: PORT_EXPOSE_KIND } as any);

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(true);
      expect(dockerService.waitForManagedAppContainersReady).not.toHaveBeenCalled();
    });
  });

  describe('when another program holds the host port the app starts on', () => {
    /** Docker Engine's wording when a program on the host already listens on the port. */
    const portTaken = (port: number) =>
      new Error(
        `Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint test-app-1 (a65f29c5): failed to bind host port 127.0.0.1:${port}/tcp: address already in use`,
      );
    const mainAllocation = (hostPort: number) => ({
      id: hostPort,
      appUrn,
      hostPort,
      containerPort: 8080,
      protocol: 'tcp' as const,
      label: 'main',
      createdAt: '',
    });
    /** Host ports Docker refuses, in the order `compose up` meets them. */
    let refusals: number[];
    /** app.env as the last write left it, which the next read returns, as the file would. */
    let appEnv: string;
    let appsRepository: ReturnType<typeof mock<AppsRepository>>;

    beforeEach(() => {
      // The manifest's port is 8080, and the app was installed on it and is stopped now.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'test-app', port: 8080, force_pull: false } as any);
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=8080', 'APP_INTERNAL_AUTHORITY=127.0.0.1:8080', 'APP_URL=http://127.0.0.1:8080'].join('\n');
      appFilesManager.getAppEnv.mockImplementation(async () => ({ content: appEnv, path: '/tmp/.env' }));
      appFilesManager.writeAppEnv.mockImplementation(async (_urn: unknown, content: string) => {
        appEnv = content;
      });
      appsRepository = (command as unknown as { moduleRef: ModuleRef }).moduleRef.get(AppsRepository) as any;
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, config: { exposureMode: 'local' } } as any);
      portManager.getMainPort.mockResolvedValue(8080);
      portManager.moveMainPort.mockResolvedValue(mainAllocation(10000));
      refusals = [];
      dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
        composeArgs.push(args);
        const refused = args.startsWith('up') ? refusals.shift() : undefined;
        if (refused !== undefined) {
          throw portTaken(refused);
        }
      });
    });

    it('starts on a reassigned port when the default port is taken', async () => {
      refusals = [8080];
      const form: { port?: number } = {};

      const result = await command.execute(appUrn, form);

      expect(result.success).toBe(true);
      expect(portManager.moveMainPort).toHaveBeenCalledExactlyOnceWith(appUrn, new Set([8080]));
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(2);
      expect(appEnv).toContain('APP_PORT=10000');
      expect(appEnv).toContain('APP_URL=http://127.0.0.1:10000');
      // The next start rebuilds APP_PORT from the row's config, so the new port is recorded there too.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { config: { exposureMode: 'local', port: 10000 }, port: 10000 });
      expect(form.port).toBe(10000);
    });

    it('says where it moved the app from and to', async () => {
      refusals = [8080];

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: true, movedHostPort: { from: 8080, to: 10000 } });
    });

    it('reports the move and the failure when the app moved and a service then crash-looped', async () => {
      refusals = [8080];
      const serviceFailure = { kind: 'restarting', service: 'summary-service', exitCode: 126 };
      dockerService.waitForManagedAppContainersReady.mockResolvedValue({
        ok: false,
        message: 'summary-service keeps restarting (exit 126)',
        errorDetail: 'app-summary-service-1 (restarting, exit 126): ',
        serviceFailure,
      });

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, serviceFailure, movedHostPort: { from: 8080, to: 10000 } });
    });

    it('names the port the app started on when Docker refuses a second one too', async () => {
      refusals = [8080, 10000];
      portManager.getMainPort.mockResolvedValueOnce(8080).mockResolvedValueOnce(10000);
      portManager.moveMainPort.mockResolvedValueOnce(mainAllocation(10000)).mockResolvedValueOnce(mainAllocation(10001));

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: true, movedHostPort: { from: 8080, to: 10001 } });
    });

    it('reports the move when the start fails on the port it moved to', async () => {
      refusals = [8080, 10000, 10001];
      portManager.getMainPort.mockResolvedValueOnce(8080).mockResolvedValueOnce(10000);
      portManager.moveMainPort.mockResolvedValueOnce(mainAllocation(10000)).mockResolvedValueOnce(mainAllocation(10001));

      const result = await command.execute(appUrn, {});

      expect(result).toMatchObject({ success: false, movedHostPort: { from: 8080, to: 10001 } });
    });

    it('reports no move when the app kept its port', async () => {
      const result = (await command.execute(appUrn, { port: 8080 })) as { movedHostPort?: unknown };

      expect(result.movedHostPort).toBeUndefined();
    });

    /*
     * Saves used to leave the table behind, so a Hub can hold a row, a config and an app.env on 18558
     * with an allocation still on 10000. The start is refused on 18558. Comparing that to the table
     * alone gave up with "see logs".
     */
    it('moves an app off a port set by hand when the table still names an older one', async () => {
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=18558', 'APP_URL=http://127.0.0.1:18558'].join('\n');
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, port: 18558, config: { exposureMode: 'local', port: 18558 } } as any);
      portManager.getMainPort.mockResolvedValue(10000);
      portManager.moveMainPort.mockResolvedValue(mainAllocation(10001));
      refusals = [18558];
      const form = { port: 18558 };

      const result = await command.execute(appUrn, form);

      expect(result).toMatchObject({ success: true, movedHostPort: { from: 18558, to: 10001 } });
      expect(portManager.moveMainPort).toHaveBeenCalledExactlyOnceWith(appUrn, new Set([18558]));
      expect(appEnv).toContain('APP_PORT=10001');
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { config: { exposureMode: 'local', port: 10001 }, port: 10001 });
      expect(form.port).toBe(10001);
    });

    // Only an `addPorts` mapping can hold that number on an app whose main service publishes nothing.
    it('leaves an app that does not publish its main port where it is', async () => {
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=18558', 'APP_URL=http://127.0.0.1:18558'].join('\n');
      portManager.getMainPort.mockResolvedValue(10000);
      refusals = [18558];

      const result = await command.execute(appUrn, { port: 18558, openPort: false, exposureMode: 'cloudflare' });

      expect(result).toMatchObject({ success: false });
      expect(portManager.moveMainPort).not.toHaveBeenCalled();
    });

    it('fails as before when the port Docker refused is not the main port', async () => {
      // An `addPorts` port from the manifest is published as written, so moving the main port would not help.
      refusals = [51820];

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(false);
      expect(portManager.moveMainPort).not.toHaveBeenCalled();
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(1);
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
