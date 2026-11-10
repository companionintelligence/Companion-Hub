import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { RestartAppCommand } from '../restart-app-command';
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
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { TranslatableError } from '@/common/error/translatable-error';
import { HttpStatus } from '@nestjs/common';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
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

// An installed compose is read with parseInstalledComposeJson: one stub stands for both parses.
vi.mock('@ci-hub/common/schemas', async (importOriginal) => {
  const parse = vi.fn().mockReturnValue({ services: [], overrides: [] });
  return { ...((await importOriginal()) as any), parseComposeJson: parse, parseInstalledComposeJson: parse };
});

vi.mock('@/modules/inference/host-rocm-availability', () => ({
  isRocmKfdPassthroughAvailable: vi.fn().mockResolvedValue(true),
}));

describe('RestartAppCommand — pull policy', () => {
  let command: RestartAppCommand;
  let dockerService: any;
  let dockerReadFacade: ReturnType<typeof mock<DockerReadFacade>>;
  let composeArgs: string[];
  let appFilesManager: any;
  let entitlements: ReturnType<typeof mock<MarketplaceEntitlementService>>;
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
    const appsRepository = mock<AppsRepository>();
    appsRepository.getApps.mockResolvedValue([]);
    marketplaceService.copyAppFromRepoToInstalled.mockResolvedValue();

    entitlements = mock<MarketplaceEntitlementService>();
    portManager = mock<PortManagerService>();
    entitlements.assertForStart.mockResolvedValue(undefined);

    const subnetManager = mock<SubnetManagerService>();
    subnetManager.allocateSubnet.mockResolvedValue('172.20.0.0/16');
    subnetManager.releaseSubnet.mockResolvedValue(undefined);

    const dockerode = mock<Dockerode>();
    // @ts-expect-error
    dockerode.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });

    dockerReadFacade = mock<DockerReadFacade>();
    dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([]);
    dockerReadFacade.describeAppCameUpFailure.mockResolvedValue({ ok: false, message: 'db keeps restarting', errorDetail: 'db (restarting)' });

    const moduleRef = {
      get: vi.fn((token: any) => {
        if (token === DockerReadFacade) return dockerReadFacade;
        if (token === LoggerService) return logger;
        if (token === ConfigurationService) return config;
        if (token === AppFilesManager) return appFilesManager;
        if (token === DockerService) return dockerService;
        if (token === AppHelpers) return appHelpers;
        if (token === TraefikConfigService) return traefikConfigService;
        if (token === MarketplaceService) return marketplaceService;
        if (token === AppsRepository) return appsRepository;
        if (token === SubnetManagerService) return subnetManager;
        if (token === EnvUtils) return new EnvUtils();
        if (token === MarketplaceEntitlementService) return entitlements;
        if (token === PortManagerService) return portManager;
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

  // Saving an edited custom app restarts it, so a new image it names arrives here rather than in a start.
  it('records an image compose pulled during the restart and leaves one that was already there', async () => {
    const onComputer = new Map([['traefik/whoami:v1.10.3', 'sha256:mine']]);
    vi.mocked(parseComposeJson).mockReturnValue({
      services: [
        { name: 'web', image: 'traefik/whoami:v1.10.2', isMain: true, internalPort: 80 },
        { name: 'side', image: 'traefik/whoami:v1.10.3' },
      ],
      overrides: [],
    } as any);
    dockerService.imageIdLocally = vi.fn(async (ref: string) => onComputer.get(ref) ?? null);
    dockerService.imageIdsLocally = vi.fn(async () => new Set(onComputer.values()));
    dockerService.imageTagsLocally = vi.fn(async () => []);
    appFilesManager.readPulledImages.mockResolvedValue({ imageIds: [], imageTags: [] });
    appFilesManager.addPulledImages.mockResolvedValue(true);
    dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
      if (args.startsWith('up')) {
        onComputer.set('traefik/whoami:v1.10.2', 'sha256:whoami');
      }
    });

    const result = await command.execute('port-test:_user' as AppUrn, {});

    expect(result.success).toBe(true);
    expect(appFilesManager.addPulledImages).toHaveBeenCalledWith('port-test:_user', { imageIds: ['sha256:whoami'], imageTags: [] });
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

  // The queued restart also carries the Hub's own restarts: a credential rotation, a saved config, an
  // inference change. Refused here, on a cached 402, a rotation strands the app on the credentials
  // it just revoked, and the failure settles the app as `stopped` while its containers keep running.
  // A person's restart is gated before it is queued, in `AppLifecycleService.restartApp`.
  it('re-provisions the app even when Start would refuse it, because a Hub restart must land', async () => {
    entitlements.assertForStart.mockRejectedValue(
      new TranslatableError('APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED', {}, HttpStatus.PAYMENT_REQUIRED),
    );

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(composeArgs.some((args) => args.startsWith('up'))).toBe(true);
  });

  // apps.yml still sends the app's routes to its old containers' addresses until it is rebuilt, and
  // Docker can hand a freed address to another app's container (CI-Hub#1944).
  it('rebuilds the Traefik routes between compose down and compose up', async () => {
    const order: string[] = [];
    dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
      order.push(args.split(' ')[0] ?? args);
    });
    traefikConfigService.regenerateTraefikConfig.mockImplementation(async (delayMs?: number) => {
      order.push(`traefik:${delayMs}`);
    });

    await command.execute(appUrn, { exposedLocal: true });

    expect(order).toEqual(['down', 'traefik:0', 'up', 'traefik:0']);
  });

  it('does not report success while a service crash-loops and says which one and why', async () => {
    const serviceFailure = { kind: 'restarting', service: 'summary-service', exitCode: 126 };
    dockerService.waitForManagedAppContainersReady.mockResolvedValue({
      ok: false,
      message: 'summary-service keeps restarting (exit 126)',
      errorDetail: 'app-summary-service-1 (restarting, exit 126): ',
      serviceFailure,
    });

    const result = await command.execute(appUrn, { exposedLocal: true });

    expect(result).toMatchObject({ success: false, message: 'summary-service keeps restarting (exit 126)', serviceFailure });
    // Its other containers go on serving, so their routes still have to be there.
    expect(traefikConfigService.regenerateTraefikConfig).toHaveBeenCalledTimes(2);
  });

  describe('a restart that did not come up', () => {
    const crashLoop = {
      ok: false,
      message: 'web keeps restarting (exit 3)',
      errorDetail: 'web (restarting, exit 3)',
      serviceFailure: { kind: 'restarting', service: 'web', exitCode: 3 },
    };
    const composeCommands = () => dockerService.composeApp.mock.calls.map(([, args]: [string, string]) => args.split(' ')[0]);

    it('takes the containers down again when someone asked for it', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      const result = await command.execute(appUrn, { stopIfNotUp: true });

      expect(result).toMatchObject({ success: false, serviceFailure: crashLoop.serviceFailure });
      expect(composeCommands()).toEqual(['down', 'up', 'down']);
    });

    it('leaves them to Docker when the Hub restarted the app itself', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);

      const result = await command.execute(appUrn, {});

      expect(result.success).toBe(false);
      expect(composeCommands()).toEqual(['down', 'up']);
    });

    it('takes nothing down when the app came up', async () => {
      const result = await command.execute(appUrn, { stopIfNotUp: true });

      expect(result.success).toBe(true);
      expect(composeCommands()).toEqual(['down', 'up']);
    });

    it('gives a slow app the longer window before calling it failed', async () => {
      await command.execute(appUrn, { stopIfNotUp: true });

      expect(dockerService.waitForManagedAppContainersReady).toHaveBeenCalledWith(appUrn, APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN);
    });

    it('still reports the failed service when the routes cannot be rebuilt', async () => {
      dockerService.waitForManagedAppContainersReady.mockResolvedValue(crashLoop);
      // The first rebuild is the one between `down` and `up`, which has always been allowed to fail the restart.
      traefikConfigService.regenerateTraefikConfig.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('traefik config is locked'));

      const result = await command.execute(appUrn, { exposedLocal: true, stopIfNotUp: true });

      expect(result).toMatchObject({ success: false, serviceFailure: crashLoop.serviceFailure });
    });

    it('takes the app down when compose up fails with a container left restarting', async () => {
      dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
        if (args.startsWith('up')) throw new Error('dependency failed to start: container test-app-db-1 is unhealthy');
      });
      dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([
        {
          id: 'db',
          service: 'db',
          containerName: 'test-app-db-1',
          state: 'restarting',
          exitCode: 1,
          restartCount: 4,
          startedAtMs: null,
          health: null,
        },
      ]);

      const result = await command.execute(appUrn, { stopIfNotUp: true });

      expect(result.success).toBe(false);
      expect(composeCommands()).toEqual(['down', 'up', 'down']);
    });

    describe('when a setup step the app waits on to finish failed', () => {
      const look = (service: string, over: Partial<AppContainerLook>): AppContainerLook => ({
        id: service,
        service,
        containerName: `test-app-${service}-1`,
        state: 'running',
        exitCode: 0,
        restartCount: 0,
        startedAtMs: null,
        health: null,
        ...over,
      });

      beforeEach(() => {
        dockerService.composeApp.mockImplementation(async (_urn: string, args: string) => {
          if (args.startsWith('up')) throw new Error('service "migrate" didn\'t complete successfully: exit 1');
        });
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([
          look('db', { health: 'healthy' }),
          look('migrate', { state: 'exited', exitCode: 1 }),
          look('web', { state: 'created' }),
        ]);
      });

      it('takes the app down when someone asked for the restart', async () => {
        const result = await command.execute(appUrn, { stopIfNotUp: true });

        expect(result.success).toBe(false);
        expect(result.message).toContain("didn't complete successfully");
        expect(composeCommands()).toEqual(['down', 'up', 'down']);
      });

      it('leaves the containers to Docker when the Hub restarted the app itself', async () => {
        const result = await command.execute(appUrn, {});

        expect(result.success).toBe(false);
        expect(composeCommands()).toEqual(['down', 'up']);
      });

      it('takes nothing down after a failed pull, which leaves no containers', async () => {
        dockerReadFacade.lookAtManagedAppContainers.mockResolvedValue([]);

        await command.execute(appUrn, { stopIfNotUp: true });

        expect(composeCommands()).toEqual(['down', 'up']);
      });
    });
  });

  it('reports success when the containers came up', async () => {
    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: true, message: `App ${appUrn} restarted successfully` });
    expect(dockerService.waitForManagedAppContainersReady).toHaveBeenCalledWith(appUrn, undefined);
  });

  it('rebuilds the Traefik routes of a Private VPN app, which leaves exposedLocal off', async () => {
    await command.execute(appUrn, { exposureMode: 'tailscale', exposedLocal: false });

    expect(traefikConfigService.regenerateTraefikConfig).toHaveBeenCalledTimes(2);
  });

  it('leaves the Traefik routes alone for an app that does not go out through Traefik', async () => {
    await command.execute(appUrn, {});

    expect(traefikConfigService.regenerateTraefikConfig).not.toHaveBeenCalled();
  });

  describe('when another program holds the host port the app restarts on', () => {
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

    beforeEach(() => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'test-app', port: 8080, force_pull: false } as any);
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=8080', 'APP_INTERNAL_AUTHORITY=127.0.0.1:8080', 'APP_URL=http://127.0.0.1:8080'].join('\n');
      appFilesManager.getAppEnv.mockImplementation(async () => ({ content: appEnv, path: '/tmp/.env' }));
      appFilesManager.writeAppEnv.mockImplementation(async (_urn: unknown, content: string) => {
        appEnv = content;
      });
      const appsRepository = (command as unknown as { moduleRef: ModuleRef }).moduleRef.get(AppsRepository) as any;
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

    it('restarts on a reassigned port when the default port is taken', async () => {
      refusals = [8080];
      const form: { port?: number } = {};

      const result = await command.execute(appUrn, form);

      expect(result.success).toBe(true);
      expect(portManager.moveMainPort).toHaveBeenCalledExactlyOnceWith(appUrn, new Set([8080]));
      expect(composeArgs.filter((args) => args.startsWith('up'))).toHaveLength(2);
      expect(appEnv).toContain('APP_PORT=10000');
      expect(form.port).toBe(10000);
      expect(result).toMatchObject({ movedHostPort: { from: 8080, to: 10000 } });
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

    it('moves an app off a port set by hand when the table still names an older one', async () => {
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=18558', 'APP_URL=http://127.0.0.1:18558'].join('\n');
      portManager.getMainPort.mockResolvedValue(10000);
      portManager.moveMainPort.mockResolvedValue(mainAllocation(10001));
      refusals = [18558];

      const result = await command.execute(appUrn, { port: 18558 });

      expect(result).toMatchObject({ success: true, movedHostPort: { from: 18558, to: 10001 } });
      expect(portManager.moveMainPort).toHaveBeenCalledExactlyOnceWith(appUrn, new Set([18558]));
    });

    it('does not move the main port when only the stale table port matches the conflict', async () => {
      appEnv = ['APP_HOSTNAME=127.0.0.1', 'APP_PORT=18558', 'APP_URL=http://127.0.0.1:18558'].join('\n');
      portManager.getMainPort.mockResolvedValue(10000);
      refusals = [10000];

      const result = await command.execute(appUrn, { port: 18558 });

      expect(result).toMatchObject({ success: false, movedHostPort: undefined });
      expect(portManager.moveMainPort).not.toHaveBeenCalled();
    });

    it('reports no move when the app came back on its port', async () => {
      const result = await command.execute(appUrn, { port: 8080 });

      expect(result.success).toBe(true);
      expect(result.movedHostPort).toBeUndefined();
    });
  });
});
