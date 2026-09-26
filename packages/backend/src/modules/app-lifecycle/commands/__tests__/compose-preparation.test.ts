import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { z } from 'zod';
import { fromError } from 'zod-validation-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ResourceAllocatorService } from '@/modules/system/resource-allocator.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { prepareAppComposeDir } from '../compose-preparation';

/** One captured `DockerComposeBuilder.getDockerCompose(...)` invocation, by parameter name. */
interface ComposeCall {
  services: Array<Record<string, unknown>>;
  form: Record<string, unknown>;
  appUrn: string;
  subnet: string;
  domain?: string;
  localDomain?: string;
  envFilePath?: string;
  originHostname?: string;
  publicHostname?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

interface BuilderConstruction {
  domain: string;
  localDomain: string;
  posixPermissionsSupported: boolean;
  options?: { loopbackHostPort?: boolean };
}

const { builderSpy, posixProbe, schemaSpy } = vi.hoisted(() => ({
  builderSpy: {
    constructions: [] as BuilderConstruction[],
    calls: [] as ComposeCall[],
    // Distinctive so the write assertion cannot pass on an empty string or a stray default.
    output: 'services:\n  nextcloud:\n    image: nextcloud:29\n',
  },
  posixProbe: vi.fn(),
  schemaSpy: {
    parse: vi.fn(),
    original: null as ((data: unknown) => unknown) | null,
  },
}));

/*
 * The builder is a separately tested unit, and two of the values this function computes
 * (`defaultCpuLimit` / `defaultMemoryLimit`) are deliberately ignored by the real builder — so its
 * YAML cannot witness them. Capture the constructor and call arguments instead: those arguments are
 * exactly what this function is responsible for deriving.
 */
vi.mock('@/modules/docker/builders/compose.builder', () => ({
  DockerComposeBuilder: class {
    constructor(domain: string, localDomain: string, posixPermissionsSupported = true, options?: { loopbackHostPort?: boolean }) {
      builderSpy.constructions.push({ domain, localDomain, posixPermissionsSupported, options });
    }

    async getDockerCompose(
      services: Array<Record<string, unknown>>,
      form: Record<string, unknown>,
      appUrn: string,
      subnet: string,
      domain?: string,
      localDomain?: string,
      envFilePath?: string,
      originHostname?: string,
      publicHostname?: string,
      cpuLimit?: string,
      memoryLimit?: string,
    ) {
      builderSpy.calls.push({
        services,
        form,
        appUrn,
        subnet,
        domain,
        localDomain,
        envFilePath,
        originHostname,
        publicHostname,
        cpuLimit,
        memoryLimit,
      });
      return builderSpy.output;
    }
  },
}));

// Only the probe is stubbed; the rest of the helper module is shared with unrelated collaborators.
vi.mock('@/common/helpers/bind-mount-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/bind-mount-helpers')>()),
  supportsPosixPermissions: posixProbe,
}));

/*
 * `parseComposeJson` throws a plain Error today, so the ZodError arm of the catch block is only
 * reachable through a collaborator. Keep the real parser as the default implementation — every
 * other test then exercises real schema parsing — and swap in a thrown ZodError for that one case.
 */
vi.mock('@ci-hub/common/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci-hub/common/schemas')>();
  schemaSpy.original = actual.parseComposeJson;
  return { ...actual, parseComposeJson: schemaSpy.parse };
});

const APP_URN = 'nextcloud:migrated' as AppUrn;

/** Both keys are read back out of the app env file and must beat userSettings and config. */
const APP_ENV_CONTENT = ['# generated', 'DOMAIN=companion.example', 'LOCAL_DOMAIN=hub.lan'].join('\n');
const APP_ENV_PATH = '/data/app-data/nextcloud/app.env';

const composeJsonFixture = () => ({
  schemaVersion: 2,
  services: [
    { name: 'nextcloud', image: 'nextcloud:29', internalPort: 80, isMain: true },
    { name: 'redis', image: 'redis:7', internalPort: 6379 },
  ],
});

/**
 * Both arms name a tag that exists nowhere else, so the merged image proves which architecture
 * was consulted rather than which fixture happened to be loaded. The harness runs on amd64; redis
 * is overridden only on arm64 so an over-eager merge is visible too.
 */
const composeJsonWithArchOverrides = () => ({
  ...composeJsonFixture(),
  overrides: [
    { architecture: 'amd64', services: [{ name: 'nextcloud', image: 'nextcloud:29-amd64-only' }] },
    {
      architecture: 'arm64',
      services: [
        { name: 'nextcloud', image: 'nextcloud:29-arm64-only' },
        { name: 'redis', image: 'redis:7-arm64-only' },
      ],
    },
  ],
});

/** The main service pins its own platform; the sidecar leaves it to the app listing's default. */
const composeJsonWithDeclaredPlatform = () => ({
  schemaVersion: 2,
  services: [
    { name: 'nextcloud', image: 'nextcloud:29', internalPort: 80, isMain: true, platform: 'linux/amd64' },
    { name: 'redis', image: 'redis:7', internalPort: 6379 },
  ],
});

type Stub = ReturnType<typeof vi.fn>;

interface Stubs {
  appFilesManager: {
    getDockerComposeJson: Stub;
    getAppEnv: Stub;
    writeDockerComposeYml: Stub;
    setAppDataDirPermissions: Stub;
  };
  marketplaceService: { getAppInfoFromAppStoreOrInstalled: Stub; copyAppFromRepoToInstalled: Stub };
  logger: { info: Stub; warn: Stub; error: Stub };
  subnetManager: { allocateSubnet: Stub };
  configService: { get: Stub; getConfig: Stub };
  resourceAllocator: { getEffectiveAppDefaults: Stub };
  registrationService: { getDeviceRegistrationInfo: Stub };
  appsRepository: { getAppCustomDomain: Stub };
  docker: { pruneContainers: Stub };
}

const makeForm = (overrides: Record<string, unknown> = {}): AppEventFormInput =>
  ({ openPort: true, skipEnv: false, skipPull: false, skipRun: false, ...overrides }) as unknown as AppEventFormInput;

const createHarness = () => {
  const stubs: Stubs = {
    appFilesManager: {
      getDockerComposeJson: vi.fn().mockResolvedValue({ path: '/data/apps/nextcloud/docker-compose.json', content: composeJsonFixture() }),
      getAppEnv: vi.fn().mockResolvedValue({ path: APP_ENV_PATH, content: APP_ENV_CONTENT }),
      writeDockerComposeYml: vi.fn().mockResolvedValue(undefined),
      setAppDataDirPermissions: vi.fn().mockResolvedValue(undefined),
    },
    marketplaceService: {
      getAppInfoFromAppStoreOrInstalled: vi.fn().mockResolvedValue({ id: 'nextcloud' }),
      copyAppFromRepoToInstalled: vi.fn().mockResolvedValue(undefined),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    subnetManager: { allocateSubnet: vi.fn().mockResolvedValue('10.128.7.0/24') },
    configService: {
      get: vi.fn((key: string) => {
        if (key === 'architecture') return 'amd64';
        if (key === 'directories') return { appDataDir: '/data/app-data' };
        return undefined;
      }),
      getConfig: vi.fn(() => ({
        domain: 'config.example',
        localDomain: 'config.local',
        userSettings: { domain: 'settings.example', localDomain: 'settings.local' },
      })),
    },
    resourceAllocator: { getEffectiveAppDefaults: vi.fn().mockResolvedValue({ cpuLimit: '4', memoryLimit: '8192M' }) },
    registrationService: { getDeviceRegistrationInfo: vi.fn().mockResolvedValue({ hubSubdomain: 'hub-desk-acme', slug: 'acme' }) },
    appsRepository: { getAppCustomDomain: vi.fn().mockResolvedValue(null) },
    docker: { pruneContainers: vi.fn().mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 }) },
  };

  const moduleRef = {
    get: (token: unknown) => {
      if (token === AppFilesManager) return stubs.appFilesManager;
      if (token === MarketplaceService) return stubs.marketplaceService;
      if (token === LoggerService) return stubs.logger;
      if (token === SubnetManagerService) return stubs.subnetManager;
      if (token === ConfigurationService) return stubs.configService;
      if (token === ResourceAllocatorService) return stubs.resourceAllocator;
      if (token === RegistrationService) return stubs.registrationService;
      if (token === AppsRepository) return stubs.appsRepository;
      // A new collaborator must be wired here deliberately rather than silently resolving undefined.
      throw new Error(`Unexpected moduleRef.get token: ${String((token as { name?: string })?.name ?? token)}`);
    },
  } as unknown as ModuleRef;

  return { stubs, moduleRef, docker: stubs.docker as unknown as Dockerode };
};

const lastComposeCall = (): ComposeCall => {
  const call = builderSpy.calls.at(-1);
  if (!call) throw new Error('DockerComposeBuilder.getDockerCompose was never called');
  return call;
};

const lastConstruction = (): BuilderConstruction => {
  const construction = builderSpy.constructions.at(-1);
  if (!construction) throw new Error('DockerComposeBuilder was never constructed');
  return construction;
};

/** `nextcloud` + hub `hub-desk-acme` in org `acme`, on the app env's LOCAL_DOMAIN / DOMAIN. */
const PLATFORM_ORIGIN_HOSTNAME = 'nextcloud-desk-acme.hub.lan';
const PLATFORM_PUBLIC_HOSTNAME = 'nextcloud-desk-acme.companion.example';

const cloudflareForm = () => makeForm({ exposureMode: 'cloudflare', openPort: false, localSubdomain: 'nextcloud' });

describe('prepareAppComposeDir', () => {
  beforeEach(() => {
    builderSpy.constructions.length = 0;
    builderSpy.calls.length = 0;
    posixProbe.mockReset();
    posixProbe.mockResolvedValue(true);
    schemaSpy.parse.mockReset();
    const original = schemaSpy.original;
    if (original) schemaSpy.parse.mockImplementation(original);
  });

  it('writes the generated compose file and only then fixes app-data permissions', async () => {
    const { stubs, moduleRef, docker } = createHarness();
    const order: string[] = [];
    stubs.appFilesManager.writeDockerComposeYml.mockImplementation(async () => {
      order.push('write');
    });
    stubs.appFilesManager.setAppDataDirPermissions.mockImplementation(async () => {
      order.push('chmod');
    });

    await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

    expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
    // chmod must not run against a directory whose compose was never regenerated.
    expect(order).toEqual(['write', 'chmod']);
    expect(lastComposeCall().envFilePath).toBe(APP_ENV_PATH);
  });

  it('builds for the app it was handed and passes the caller form through untouched', async () => {
    const { stubs, moduleRef, docker } = createHarness();
    const form = makeForm({ exposureMode: 'local', openPort: false, localSubdomain: 'nextcloud' });

    await prepareAppComposeDir(moduleRef, docker, APP_URN, form);

    const call = lastComposeCall();
    expect(call.appUrn).toBe(APP_URN);
    // The builder reads every user choice off this object; handing it a rebuilt or empty form
    // silently discards exposure mode, port publishing and the chosen subdomain.
    expect(call.form).toMatchObject({ exposureMode: 'local', openPort: false, localSubdomain: 'nextcloud' });
    // Reading another app's env or listing would build this app's compose from foreign values.
    expect(stubs.appFilesManager.getAppEnv).toHaveBeenCalledWith(APP_URN);
    expect(stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled).toHaveBeenCalledWith(APP_URN);
    expect(stubs.appFilesManager.setAppDataDirPermissions).toHaveBeenCalledWith(APP_URN);
  });

  describe('domain resolution', () => {
    it('prefers the app env DOMAIN/LOCAL_DOMAIN over userSettings and over the global config', async () => {
      const { moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastConstruction()).toMatchObject({ domain: 'companion.example', localDomain: 'hub.lan' });
      expect(lastComposeCall()).toMatchObject({ domain: 'companion.example', localDomain: 'hub.lan' });
    });

    it('falls back to userSettings when the app env names neither domain', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.appFilesManager.getAppEnv.mockResolvedValue({ path: APP_ENV_PATH, content: '# generated\nAPP_PORT=8080' });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      // userSettings is the rung between the app env and the appliance-wide config.
      expect(lastConstruction()).toMatchObject({ domain: 'settings.example', localDomain: 'settings.local' });
      expect(lastComposeCall()).toMatchObject({ domain: 'settings.example', localDomain: 'settings.local' });
    });

    it('builds on the configured domains when the app has no env file yet', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // First install: generateEnvFile has not run, so the manager reports the path with no content.
      stubs.appFilesManager.getAppEnv.mockResolvedValue({ path: APP_ENV_PATH, content: null });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      // Parsing that absent content as a string throws, which the outer catch turns into a compose
      // failure — an app would be unable to reach its very first build.
      expect(lastConstruction()).toMatchObject({ domain: 'settings.example', localDomain: 'settings.local' });
      expect(lastComposeCall().envFilePath).toBe(APP_ENV_PATH);
    });

    it('reads the domains through configService.get when the config service exposes no snapshot', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // A ConfigurationService without getConfig (older builds, and a partially booted container)
      // must still resolve domains rather than throwing before the shaped catch block is reachable.
      Reflect.deleteProperty(stubs.configService, 'getConfig');
      stubs.appFilesManager.getAppEnv.mockResolvedValue({ path: APP_ENV_PATH, content: '# generated' });
      stubs.configService.get.mockImplementation((key: string) => {
        if (key === 'architecture') return 'amd64';
        if (key === 'directories') return { appDataDir: '/data/app-data' };
        if (key === 'domain') return 'get-domain.example';
        if (key === 'localDomain') return 'get-local.example';
        // Only localDomain is set here, so each value has to come from its own key: the domain from
        // the config rung and the localDomain from the userSettings rung.
        if (key === 'userSettings') return { localDomain: 'get-settings.local' };
        return undefined;
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastConstruction()).toMatchObject({ domain: 'get-domain.example', localDomain: 'get-settings.local' });
      expect(lastComposeCall()).toMatchObject({ domain: 'get-domain.example', localDomain: 'get-settings.local' });
    });

    it('falls back to the global config when neither the app env nor userSettings names a domain', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.appFilesManager.getAppEnv.mockResolvedValue({ path: APP_ENV_PATH, content: '' });
      stubs.configService.getConfig.mockReturnValue({
        domain: 'config.example',
        localDomain: 'config.local',
        userSettings: { defaultAppCpuLimit: '2' },
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastConstruction()).toMatchObject({ domain: 'config.example', localDomain: 'config.local' });
      expect(lastComposeCall()).toMatchObject({ domain: 'config.example', localDomain: 'config.local' });
    });
  });

  describe('architecture overrides', () => {
    it('merges the overrides for the running architecture only', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/data/apps/nextcloud/docker-compose.json',
        content: composeJsonWithArchOverrides(),
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const { services } = lastComposeCall();
      // amd64 is what configService reports; picking the wrong arm ships an unrunnable image.
      expect(services.find((service) => service.name === 'nextcloud')?.image).toBe('nextcloud:29-amd64-only');
      // redis is overridden on arm64 only, so it must keep the base image here.
      expect(services.find((service) => service.name === 'redis')?.image).toBe('redis:7');
    });
  });

  describe('compose parsing failures', () => {
    it('turns a ZodError into a readable maintainer-facing message instead of leaking the raw Zod error', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      const parsed = z.object({ services: z.array(z.object({ image: z.string() })) }).safeParse({ services: [{ image: 42 }] });
      if (parsed.success) throw new Error('fixture must fail validation');
      const zodError = parsed.error;
      schemaSpy.parse.mockImplementation(() => {
        throw zodError;
      });

      const thrown = await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm()).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain(`Error generating docker-compose.yml file for app ${APP_URN}.`);
      expect(message).toContain(fromError(zodError).toString());
      expect(message).toContain('Report this issue to the appstore maintainer.');
      // ZodError#message is a serialized issue array; surfacing it is the leak this branch exists to prevent.
      expect(message).not.toContain(zodError.message);
      expect(stubs.appFilesManager.writeDockerComposeYml).not.toHaveBeenCalled();
      expect(stubs.appFilesManager.setAppDataDirPermissions).not.toHaveBeenCalled();
      // The thrown message reaches the installing user; the server log is the maintainer's only copy.
      expect(stubs.logger.error).toHaveBeenCalledWith(`Error generating docker-compose.yml file for app ${APP_URN}`);
      expect(stubs.logger.error).toHaveBeenCalledWith(fromError(zodError).toString());
      expect(stubs.logger.error).toHaveBeenCalledWith('Report this issue to the appstore maintainer.');
    });

    it('keeps a non-Zod failure on the bare message, with no maintainer instruction', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      const cause = new Error('no free subnet');
      stubs.subnetManager.allocateSubnet.mockRejectedValue(cause);

      const thrown = await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm()).catch((error: unknown) => error);

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toBe(`Error generating docker-compose.yml file for app ${APP_URN}.`);
      expect(message).not.toContain('appstore maintainer');
      expect(stubs.appFilesManager.setAppDataDirPermissions).not.toHaveBeenCalled();
      // The generic thrown message names no cause, so losing either log leaves nothing to debug.
      expect(stubs.logger.error).toHaveBeenCalledWith(`Error generating docker-compose.yml file for app ${APP_URN}`);
      expect(stubs.logger.error).toHaveBeenCalledWith(cause);
    });
  });

  describe('cloudflare hostnames', () => {
    it('computes the platform origin and public hostnames from the device registration', async () => {
      const { moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, cloudflareForm());

      expect(lastComposeCall()).toMatchObject({
        originHostname: PLATFORM_ORIGIN_HOSTNAME,
        publicHostname: PLATFORM_PUBLIC_HOSTNAME,
      });
    });

    it('builds the public hostname on the public domain the user selected on the form', async () => {
      const { moduleRef, docker } = createHarness();
      // Shares no suffix with the app env DOMAIN, so a hostname built from the wrong source cannot
      // coincidentally match.
      const form = makeForm({ exposureMode: 'cloudflare', openPort: false, localSubdomain: 'nextcloud', publicDomain: 'chosen.tunnel.test' });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, form);

      const call = lastComposeCall();
      expect(call.publicHostname).toBe('nextcloud-desk-acme.chosen.tunnel.test');
      expect(call.publicHostname).not.toBe(PLATFORM_PUBLIC_HOSTNAME);
      // The selected public domain is an ingress choice; the internal origin stays on LOCAL_DOMAIN.
      expect(call.originHostname).toBe(PLATFORM_ORIGIN_HOSTNAME);
    });

    it('lets the bound custom domain override the public hostname, leaving the internal origin alone', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // Stored with display casing / trailing dot; env generation normalizes, so the header must too.
      stubs.appsRepository.getAppCustomDomain.mockResolvedValue('Cloud.Example.COM.');

      await prepareAppComposeDir(moduleRef, docker, APP_URN, cloudflareForm());

      const call = lastComposeCall();
      expect(stubs.appsRepository.getAppCustomDomain).toHaveBeenCalledWith(APP_URN);
      // X-Forwarded-Host is built from this; drift from generateEnvFile silently breaks OAuth redirects.
      expect(call.publicHostname).toBe('cloud.example.com');
      expect(call.publicHostname).not.toBe(PLATFORM_PUBLIC_HOSTNAME);
      // The origin Host header stays internal — a custom domain must not rewrite it.
      expect(call.originHostname).toBe(PLATFORM_ORIGIN_HOSTNAME);
    });

    it('falls back to the platform hostname and warns when the custom domain lookup fails', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.appsRepository.getAppCustomDomain.mockRejectedValue(new Error('db connection lost'));

      await prepareAppComposeDir(moduleRef, docker, APP_URN, cloudflareForm());

      // A dead database must not fail the whole compose regeneration.
      expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
      expect(lastComposeCall().publicHostname).toBe(PLATFORM_PUBLIC_HOSTNAME);
      expect(stubs.logger.warn).toHaveBeenCalledWith(expect.stringContaining(APP_URN));
      expect(stubs.logger.warn).toHaveBeenCalledWith(expect.stringContaining('db connection lost'));
    });

    it('drops the hub and org segments when the device is not yet registered', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.registrationService.getDeviceRegistrationInfo.mockResolvedValue(null);

      await prepareAppComposeDir(moduleRef, docker, APP_URN, cloudflareForm());

      const call = lastComposeCall();
      // Apps get installed before the hub finishes claiming an org; treating the registration as
      // guaranteed here turns that window into a compose generation failure.
      expect(call.originHostname).toBe('nextcloud.hub.lan');
      expect(call.publicHostname).toBe('nextcloud.companion.example');
    });

    it('skips hostname computation entirely when the app publishes a host port', async () => {
      const { stubs, moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'cloudflare', openPort: true }));

      expect(lastComposeCall()).toMatchObject({ originHostname: undefined, publicHostname: undefined });
      expect(stubs.registrationService.getDeviceRegistrationInfo).not.toHaveBeenCalled();
      expect(stubs.appsRepository.getAppCustomDomain).not.toHaveBeenCalled();
    });

    it('skips hostname computation for a local-only app even without an open port', async () => {
      const { stubs, moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'local', openPort: false }));

      expect(lastComposeCall()).toMatchObject({ originHostname: undefined, publicHostname: undefined });
      expect(stubs.registrationService.getDeviceRegistrationInfo).not.toHaveBeenCalled();
    });

    it('treats a legacy exposedLocal form with no exposureMode as cloudflare', async () => {
      const { moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposedLocal: true, openPort: false, localSubdomain: 'nextcloud' }));

      expect(lastComposeCall().originHostname).toBe(PLATFORM_ORIGIN_HOSTNAME);
    });

    it('derives the subdomain from the app URN when the form does not name one', async () => {
      const { moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'cloudflare', openPort: false }));

      expect(lastComposeCall().originHostname).toBe('nextcloud-migrated-desk-acme.hub.lan');
    });
  });

  describe('POSIX permission probing', () => {
    it('threads an unsupported app-data filesystem into the compose builder', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      posixProbe.mockResolvedValue(false);

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(posixProbe).toHaveBeenCalledWith('/data/app-data');
      // false is what redirects ownership-sensitive volumes to named volumes on Windows-backed mounts.
      expect(lastConstruction().posixPermissionsSupported).toBe(false);
      expect(stubs.logger.info).toHaveBeenCalledWith(expect.stringContaining('/data/app-data cannot carry POSIX permissions'));
    });

    it('assumes support and skips the probe when no app-data directory is configured', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.configService.get.mockImplementation((key: string) => (key === 'architecture' ? 'amd64' : undefined));

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(posixProbe).not.toHaveBeenCalled();
      expect(lastConstruction().posixPermissionsSupported).toBe(true);
    });
  });

  describe('stdio MCP apps', () => {
    it('forces stdin_open on the main service so the JSON-RPC server does not EOF at boot', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ id: 'nextcloud', mcp: { transport: 'stdio' } });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const { services } = lastComposeCall();
      expect(services.map((service) => service.name)).toEqual(['nextcloud', 'redis']);
      expect(services.find((service) => service.name === 'nextcloud')?.stdinOpen).toBe(true);
      // Only the main process reads MCP from stdin; sidecars keep the store's own setting.
      expect(services.find((service) => service.name === 'redis')?.stdinOpen).toBeUndefined();
    });

    it('leaves stdin closed for an app with a non-stdio MCP transport', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ id: 'nextcloud', mcp: { transport: 'http' } });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const main = lastComposeCall().services.find((service) => service.name === 'nextcloud');
      expect(main).toBeDefined();
      expect(main?.stdinOpen).toBeUndefined();
    });

    it('still builds when the app listing cannot be resolved', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // Note: the source guards this with `Promise.resolve(...).catch(...)`, so only a rejected
      // promise is tolerated — a synchronous throw would fall through to the outer catch.
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockRejectedValue(new Error('appstore offline'));

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const { services } = lastComposeCall();
      expect(services.map((service) => service.name)).toEqual(['nextcloud', 'redis']);
      // An offline appstore must not block a rebuild of an app that is already installed.
      expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
    });
  });

  describe('host port interface', () => {
    it('keeps the host port on loopback for an app holding a Hub MCP key', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // CI-OpenClaw's and CI-Hermes' shape: an MCP client with no edge_auth block.
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        id: 'ci-openclaw',
        exposable: true,
        hub_integration: { mcp_client: true },
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'local' }));

      expect(lastConstruction().options).toEqual({ loopbackHostPort: true });
    });

    it('keeps the host port on loopback for an app that asks for edge auth', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        id: 'opencode',
        exposable: true,
        hub_integration: { edge_auth: { default: true } },
      });

      // The stored enableAuth is no opt-out: an install that never decided also reads `false`.
      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'local', enableAuth: false }));

      expect(lastConstruction().options).toEqual({ loopbackHostPort: true });
    });

    it('publishes on every interface for an app with neither', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ id: 'nextcloud', exposable: true, hub_integration: {} });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm({ exposureMode: 'local', enableAuth: true }));

      expect(lastConstruction().options).toEqual({ loopbackHostPort: false });
    });

    it('keeps the all-interfaces default and says so when the listing cannot be resolved', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockRejectedValue(new Error('appstore offline'));

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastConstruction().options).toEqual({ loopbackHostPort: false });
      expect(stubs.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`No manifest for ${APP_URN}`));
    });
  });

  describe('runtime platform defaulting', () => {
    it('applies the listing runtime_platform only to services that do not pin their own', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/data/apps/nextcloud/docker-compose.json',
        content: composeJsonWithDeclaredPlatform(),
      });
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ id: 'nextcloud', runtime_platform: 'linux/arm64' });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const { services } = lastComposeCall();
      // The listing default is what makes an emulated image run at all on a foreign host arch.
      expect(services.find((service) => service.name === 'redis')?.platform).toBe('linux/arm64');
      // A service that pins its own platform knows better than the listing-wide default.
      expect(services.find((service) => service.name === 'nextcloud')?.platform).toBe('linux/amd64');
    });

    it('leaves platform unset when the listing declares no runtime_platform', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ id: 'nextcloud' });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      // An invented `platform: undefined` key would still serialize into the compose file.
      for (const service of lastComposeCall().services) {
        expect(service).not.toHaveProperty('platform');
      }
    });
  });

  describe('resource limits', () => {
    it('passes the allocator defaults straight through', async () => {
      const { moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastComposeCall()).toMatchObject({ cpuLimit: '4', memoryLimit: '8192M' });
    });

    it('falls back to the trimmed user-configured cpu limit when the allocator fails, without failing the build', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.resourceAllocator.getEffectiveAppDefaults.mockRejectedValue(new Error('host metrics unavailable'));
      stubs.configService.getConfig.mockReturnValue({
        domain: 'config.example',
        localDomain: 'config.local',
        userSettings: { defaultAppCpuLimit: '  1.5  ', defaultAppMemoryLimit: '512M' },
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      const call = lastComposeCall();
      expect(call.cpuLimit).toBe('1.5');
      // The fallback deliberately covers cpu only — memory is left unset rather than guessed.
      expect(call.memoryLimit).toBeUndefined();
      expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
      expect(stubs.logger.warn).toHaveBeenCalledWith(expect.stringContaining('host metrics unavailable'));
    });

    it('drops a blank user-configured cpu limit rather than emitting an empty limit', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.resourceAllocator.getEffectiveAppDefaults.mockRejectedValue(new Error('host metrics unavailable'));
      stubs.configService.getConfig.mockReturnValue({
        domain: 'config.example',
        localDomain: 'config.local',
        userSettings: { defaultAppCpuLimit: '   ' },
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(lastComposeCall().cpuLimit).toBeUndefined();
    });
  });

  describe('subnet allocation', () => {
    it('excludes the caller-supplied subnets and builds on the subnet it gets back', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.subnetManager.allocateSubnet.mockResolvedValue('10.128.9.0/24');
      const excludeSubnets = ['10.128.0.0/24', '10.128.1.0/24'];

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm(), { excludeSubnets });

      // Losing this argument hands a concurrently-installing app the same subnet.
      expect(stubs.subnetManager.allocateSubnet).toHaveBeenCalledWith(APP_URN, 0, excludeSubnets);
      expect(lastComposeCall().subnet).toBe('10.128.9.0/24');
    });

    it('excludes nothing when the caller passes no options', async () => {
      const { stubs, moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(stubs.subnetManager.allocateSubnet).toHaveBeenCalledWith(APP_URN, 0, []);
    });
  });

  describe('stale container pruning', () => {
    it('prunes only the containers labelled for this app, under both label schemes', async () => {
      const { stubs, moduleRef, docker } = createHarness();

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      // Pruning is destructive and its result is only logged: a filter that dropped the URN, or
      // carried another app's, would reap containers this install does not own and nothing here
      // would fail.
      expect(stubs.docker.pruneContainers).toHaveBeenNthCalledWith(1, { filters: { label: [`ci-hub.appurn=${APP_URN}`] } });
      expect(stubs.docker.pruneContainers).toHaveBeenNthCalledWith(2, { filters: { label: [`ci-os-hub.appurn=${APP_URN}`] } });
    });

    it('reports both the current and legacy label prunes as one total', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.docker.pruneContainers.mockImplementation(async (options: { filters: { label: string[] } }) => {
        const label = options.filters.label[0] ?? '';
        if (label.startsWith('ci-hub.appurn=')) return { ContainersDeleted: ['current-1'], SpaceReclaimed: 1024 * 1024 };
        return { ContainersDeleted: ['legacy-1'], SpaceReclaimed: 2 * 1024 * 1024 };
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(stubs.logger.info).toHaveBeenCalledWith('Pruned containers:', ['current-1', 'legacy-1'], 'Space reclaimed:', 3, 'MB');
    });

    it('treats a prune response with no counters as zero rather than NaN', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      // Dockerode omits both fields when nothing matched the filter; unguarded arithmetic on that
      // response logs `NaN MB` and unguarded spreading throws before the build even starts.
      stubs.docker.pruneContainers.mockImplementation(async (options: { filters: { label: string[] } }) => {
        const label = options.filters.label[0] ?? '';
        if (label.startsWith('ci-hub.appurn=')) return { ContainersDeleted: ['current-1'], SpaceReclaimed: 4 * 1024 * 1024 };
        return {};
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(stubs.logger.info).toHaveBeenCalledWith('Pruned containers:', ['current-1'], 'Space reclaimed:', 4, 'MB');
    });

    it('keeps going when the current-label prune fails', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.docker.pruneContainers.mockImplementation(async (options: { filters: { label: string[] } }) => {
        const label = options.filters.label[0] ?? '';
        if (label.startsWith('ci-hub.appurn=')) throw new Error('docker daemon restarting');
        return { ContainersDeleted: ['legacy-1'], SpaceReclaimed: 2 * 1024 * 1024 };
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      // This prune runs before the try block, so an unguarded rejection escapes as a raw Dockerode
      // error and aborts a rebuild that never needed the prune to succeed.
      expect(stubs.logger.info).toHaveBeenCalledWith('Pruned containers:', ['legacy-1'], 'Space reclaimed:', 2, 'MB');
      expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
    });

    it('keeps going when the legacy-label prune fails', async () => {
      const { stubs, moduleRef, docker } = createHarness();
      stubs.docker.pruneContainers.mockImplementation(async (options: { filters: { label: string[] } }) => {
        const label = options.filters.label[0] ?? '';
        if (label.startsWith('ci-hub.appurn=')) return { ContainersDeleted: ['current-1'], SpaceReclaimed: 1024 * 1024 };
        throw new Error('no such filter');
      });

      await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

      expect(stubs.logger.info).toHaveBeenCalledWith('Pruned containers:', ['current-1'], 'Space reclaimed:', 1, 'MB');
      expect(stubs.appFilesManager.writeDockerComposeYml).toHaveBeenCalledWith(APP_URN, builderSpy.output);
    });
  });

  it('copies the app from the repo and re-reads it when the installed compose json is missing', async () => {
    const { stubs, moduleRef, docker } = createHarness();
    stubs.appFilesManager.getDockerComposeJson
      .mockResolvedValueOnce({ path: '/data/apps/nextcloud/docker-compose.json', content: null })
      .mockResolvedValueOnce({ path: '/data/apps/nextcloud/docker-compose.json', content: composeJsonFixture() });

    await prepareAppComposeDir(moduleRef, docker, APP_URN, makeForm());

    expect(stubs.marketplaceService.copyAppFromRepoToInstalled).toHaveBeenCalledWith(APP_URN);
    expect(lastComposeCall().services).toHaveLength(2);
  });
});
