import { Test, TestingModule } from '@nestjs/testing';
import { CustomAppService } from '../custom-apps.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CustomAppService', () => {
  let service: CustomAppService;
  let filesystem: MockProxy<FilesystemService>;
  let configService: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let logger: MockProxy<LoggerService>;

  beforeEach(async () => {
    filesystem = mock<FilesystemService>();
    configService = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    logger = mock<LoggerService>();

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomAppService,
        { provide: FilesystemService, useValue: filesystem },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: LoggerService, useValue: logger },
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
