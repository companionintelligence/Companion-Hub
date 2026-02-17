import fs from 'node:fs';
import { AppService } from '@/app.service';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { FsMock } from '@/tests/__mocks__/fs';
import { RegistryService } from '@/utils/registry/registry.service';
import { faker } from '@faker-js/faker';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DOCKERODE } from '@/modules/docker/docker.module';

describe('AppService', () => {
  let appService: AppService;
  let configurationService = mock<ConfigurationService>();
  let registryService = mock<RegistryService>();

  beforeEach(async () => {
    const Dockerode = vi.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppService,
        FilesystemService,
        {
          provide: DOCKERODE,
          useFactory: () => Dockerode,
          inject: [],
        },
      ],
    })
      .useMocker(mock)
      .compile();

    appService = moduleRef.get(AppService);
    configurationService = moduleRef.get(ConfigurationService);
    registryService = moduleRef.get(RegistryService);
  });

  describe('getVersion', () => {
    it('should return current version when no newer tags exist', async () => {
      const version = faker.system.semver();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      registryService.getTagsSince.mockResolvedValueOnce([]);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe(version);
      expect(result.releases).toEqual([]);
      expect(registryService.getTagsSince).toHaveBeenCalledWith('ci-os-hub', version);
    });

    it('should return latest version when newer tags exist', async () => {
      const version = '1.0.0';
      const newerTags = ['1.2.0', '1.1.0'];
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      registryService.getTagsSince.mockResolvedValueOnce(newerTags);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe('1.2.0');
      expect(result.releases).toEqual([
        { version: '1.2.0', body: 'Release 1.2.0' },
        { version: '1.1.0', body: 'Release 1.1.0' },
      ]);
    });
  });

  describe('copyAssets', () => {
    it('should create base folder structure', async () => {
      const appDir = APP_DIR;
      const dataDir = DATA_DIR;
      const appDataDir = APP_DATA_DIR;
      const directories = { appDir, dataDir, appDataDir };
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));

      await appService.copyAssets();

      expect((fs as unknown as FsMock).tree()).toMatchSnapshot();
    });
  });
});
