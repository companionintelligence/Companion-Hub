import { Test, TestingModule } from '@nestjs/testing';
import { CustomAppService } from '../custom-apps.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CustomAppService', () => {
  let service: CustomAppService;
  let filesystem: MockProxy<FilesystemService>;
  let configService: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let logger: MockProxy<LoggerService>;
  let portManager: MockProxy<PortManagerService>;

  beforeEach(async () => {
    filesystem = mock<FilesystemService>();
    configService = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    logger = mock<LoggerService>();
    portManager = mock<PortManagerService>();

    configService.get.mockImplementation((key) => {
      if (key === 'directories') return { dataDir: '/data', appDataDir: '/app-data' } as any;
      if (key === 'demoMode') return false;
      return null;
    });

    filesystem.createDirectory.mockResolvedValue(true);
    filesystem.createDirectories.mockResolvedValue(true);
    filesystem.writeJsonFile.mockResolvedValue(true);
    filesystem.writeTextFile.mockResolvedValue(true);
    filesystem.writeBinaryFile.mockResolvedValue(true);

    // Nothing holds a port, and the port manager hands out 10000 for whatever it is asked.
    appsRepository.getAppsByPort.mockResolvedValue([] as any);
    portManager.isPortAvailable.mockResolvedValue(true);
    portManager.getAllAllocations.mockResolvedValue([]);
    portManager.releaseAll.mockResolvedValue(0);
    portManager.allocatePorts.mockImplementation(async (appUrn, requests) =>
      requests.map((request, index) => ({
        id: index + 1,
        appUrn,
        hostPort: 10000,
        containerPort: request.containerPort,
        protocol: 'tcp' as const,
        label: request.label,
        createdAt: '2026-10-10T00:00:00.000Z',
      })),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomAppService,
        { provide: FilesystemService, useValue: filesystem },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: LoggerService, useValue: logger },
        { provide: PortManagerService, useValue: portManager },
      ],
    }).compile();

    service = module.get<CustomAppService>(CustomAppService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createCustomApp', () => {
    it('should create app when valid', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);

      const config = {
        version: '3',
        services: [{ name: 'web', image: 'nginx', isMain: true }],
      };

      const result = await service.createCustomApp({ name: 'myapp', config: config as any });

      expect(result.appUrn).toBe('myapp:_user' as any as any);
      expect(filesystem.createDirectories).toHaveBeenCalled();
      expect(filesystem.writeTextFile).toHaveBeenCalledWith(
        expect.stringContaining('docker-compose.json'),
        expect.stringContaining('"version": "3"'),
      );
      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    it('derives a URL-safe slug from a free-form display name', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);

      const config = { version: '3', services: [{ name: 'web', image: 'nginx', isMain: true }] };
      const result = await service.createCustomApp({ name: 'My Cool App', config: config as any });

      expect(result.appUrn).toBe('my-cool-app:_user' as any);
      expect(result.appName).toBe('my-cool-app');
      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ appName: 'my-cool-app', status: 'stopped' }));
    });

    it('hyphenates dots in the display name instead of truncating', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);

      const config = { version: '3', services: [{ name: 'web', image: 'nginx', isMain: true }] };
      const result = await service.createCustomApp({ name: 'Node.js Dashboard', config: config as any });

      expect(result.appUrn).toBe('node-js-dashboard:_user' as any);
      expect(result.appName).toBe('node-js-dashboard');
    });

    it('throws when the display name has no slug-able characters', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await expect(service.createCustomApp({ name: '///', config: {} as any })).rejects.toThrow('CUSTOM_APP_NAME_NO_SLUG');
    });

    it('throws when the derived slug is reserved', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await expect(service.createCustomApp({ name: 'Create', config: {} as any })).rejects.toThrow('CUSTOM_APP_NAME_RESERVED');
    });

    it('should throw if duplicate', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);
      await expect(service.createCustomApp({ name: 'myapp', config: '' as any as any })).rejects.toThrow('CUSTOM_APP_ERROR_DUPLICATE_NAME');
    });
  });

  /*
   * A custom app is created, not installed, so it never got the host port an install allocates: its
   * main service was published on the host at its own internal port. One on port 80, which the Hub's
   * Traefik holds, could never start ("Bind for 0.0.0.0:80 failed: port is already allocated").
   */
  describe('the host port a custom app publishes on', () => {
    const createWith = (services: unknown[]) => service.createCustomApp({ name: 'Port Probe', config: { services } as any });
    const refusalOf = (services: unknown[]) =>
      createWith(services).then(
        () => {
          throw new Error('expected the create to be refused');
        },
        (error: { getResponse: () => unknown; getStatus: () => number }) => ({ response: error.getResponse(), status: error.getStatus() }),
      );
    const webOn = (internalPort: string, addPorts?: unknown[]) => [{ name: 'web', image: 'nginx:alpine', isMain: true, internalPort, addPorts }];

    beforeEach(() => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      configService.get.mockImplementation((key) => {
        if (key === 'directories') return { dataDir: '/data', appDataDir: '/app-data' } as any;
        if (key === 'demoMode') return false;
        if (key === 'userSettings') return { port: 80, sslPort: 443 } as any;
        return null;
      });
    });

    it('gets one from the port manager, asking for its internal port first, and keeps it on the row', async () => {
      await createWith(webOn('80'));

      expect(portManager.allocatePorts).toHaveBeenCalledWith('port-probe:_user', [{ containerPort: 80, label: 'main', preferredHostPort: 80 }]);
      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ config: { port: 10000 }, port: 10000 }));
    });

    it('allocates none for an app with no single access port', async () => {
      await createWith(webOn('${PORT}'));

      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ config: {} }));
    });

    it('gives the allocation back when the app cannot be created after it', async () => {
      appsRepository.createApp.mockRejectedValue(new Error('db down'));

      await expect(createWith(webOn('80'))).rejects.toThrow('CUSTOM_APP_ERROR_CREATION_FAILED');
      expect(portManager.releaseAll).toHaveBeenCalledWith('port-probe:_user');
    });

    it.each([
      ['the port the Hub serves HTTP on', () => undefined, 80],
      ['the port the Hub serves HTTPS on', () => undefined, 443],
      ['a port another app publishes', () => appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'wordpress' }] as any), 8213],
      ['a port the port manager keeps for the Hub', () => portManager.isPortAvailable.mockResolvedValue(false), 5002],
      [
        'a privileged port another app was given',
        () => portManager.getAllAllocations.mockResolvedValue([{ hostPort: 53, protocol: 'tcp', appUrn: 'adguard:ci-marketplace' }] as any),
        53,
      ],
    ])('refuses a Port Mapping on %s, naming it, before anything is written', async (_label, arrange, hostPort) => {
      arrange();

      await expect(refusalOf(webOn('8081', [{ containerPort: 80, hostPort }]))).resolves.toEqual({
        response: { message: 'CUSTOM_APP_ERROR_HOST_PORT_IN_USE', intlParams: { port: String(hostPort) } },
        status: 409,
      });
      expect(filesystem.createDirectories).not.toHaveBeenCalled();
      expect(portManager.allocatePorts).not.toHaveBeenCalled();
      expect(appsRepository.createApp).not.toHaveBeenCalled();
    });

    it('refuses the same host port mapped twice', async () => {
      await expect(
        refusalOf(
          webOn('8081', [
            { containerPort: 80, hostPort: '9100' },
            { containerPort: 81, hostPort: 9100 },
          ]),
        ),
      ).resolves.toMatchObject({ response: { message: 'CUSTOM_APP_ERROR_HOST_PORT_IN_USE', intlParams: { port: '9100' } } });
    });

    it('allows a privileged Port Mapping nobody holds, such as 53 for a DNS server', async () => {
      await expect(createWith(webOn('8081', [{ containerPort: 53, hostPort: 53, udp: true }]))).resolves.toMatchObject({
        appUrn: 'port-probe:_user',
      });
    });

    it('keeps the main port off a host port the app maps itself', async () => {
      await createWith(webOn('9200', [{ containerPort: 9200, hostPort: 9200 }]));

      expect(portManager.allocatePorts).toHaveBeenCalledWith('port-probe:_user', [
        { containerPort: 9200, label: 'main', preferredHostPort: undefined },
      ]);
    });
  });

  describe('uploadAppImage', () => {
    it('should upload image', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);
      await service.uploadAppImage('myapp:_user' as any as any, Buffer.from('test'));

      expect(filesystem.writeBinaryFile).toHaveBeenCalled();
    });

    it('should throw if not custom app', async () => {
      await expect(service.uploadAppImage('app:store' as any as any, Buffer.from('test'))).rejects.toThrow('CUSTOM_APP_ERROR_NOT_CUSTOM');
    });
  });
  describe('the access port written to config.json', () => {
    const portWrittenFor = async (internalPort: unknown) => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await service.createCustomApp({ name: 'Portly', config: { services: [{ name: 'web', image: 'nginx', isMain: true, internalPort }] } as any });
      const call = filesystem.writeJsonFile.mock.calls.find(([file]) => String(file).endsWith('/config.json'));
      return (call?.[1] as { port?: number } | undefined)?.port;
    };

    it.each([
      ['a number', 8080, 8080],
      ['the string the create form submits', '8080', 8080],
      ['a string with stray whitespace', ' 3000 ', 3000],
    ])('takes %s', async (_name, input, expected) => {
      await expect(portWrittenFor(input)).resolves.toBe(expected);
    });

    it.each([
      ['an environment reference', '${APP_PORT}'],
      ['a range', '8000-8010'],
      ['zero', 0],
      ['a number past the port range', 70000],
      ['an empty string', ''],
    ])('leaves the port unset for %s', async (_name, input) => {
      await expect(portWrittenFor(input)).resolves.toBeUndefined();
    });
  });

  // These write `docker-compose.json` / `config.json` / `description.md` into `apps/<store>/<app>/`,
  // a layout every installed store app shares. The URN is whatever the caller sent.
  describe('provenance: only apps created here can be rewritten here', () => {
    const OFFICIAL = 'open-webui:ci-marketplace' as any;
    const CUSTOM = 'myapp:_user' as any;

    it('refuses to rewrite the compose file of a store app', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await expect(service.updateCustomApp(OFFICIAL, { services: [] } as any)).rejects.toThrow('CUSTOM_APP_ERROR_NOT_CUSTOM');

      expect(filesystem.writeTextFile).not.toHaveBeenCalled();
    });

    it('refuses to rewrite the metadata of a store app', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await expect(service.updateAppMetadata(OFFICIAL, '# changed')).rejects.toThrow('CUSTOM_APP_ERROR_NOT_CUSTOM');

      expect(filesystem.writeTextFile).not.toHaveBeenCalled();
      expect(filesystem.writeJsonFile).not.toHaveBeenCalled();
    });

    it('still rewrites the compose file of a custom app', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await service.updateCustomApp(CUSTOM, { services: [] } as any);

      expect(filesystem.writeTextFile).toHaveBeenCalledWith('/data/apps/_user/myapp/docker-compose.json', expect.any(String));
    });
  });
});
