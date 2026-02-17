import { RegistryService } from '@/utils/registry/registry.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

describe('RegistryService', () => {
  let registryService: RegistryService;
  let httpService = mock<HttpService>();
  let configurationService = mock<ConfigurationService>();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RegistryService],
    })
      .useMocker(mock)
      .compile();

    registryService = moduleRef.get(RegistryService);
    httpService = moduleRef.get(HttpService);
    configurationService = moduleRef.get(ConfigurationService);
  });

  describe('getTags / getTagsSince', () => {
    it('should throw if CI_CLOUD_URL is not configured', async () => {
      configurationService.get.mockReturnValue('');

      await expect(registryService.getTagsSince('ci-os-hub', '1.0.0')).rejects.toThrow('ciCloudUrl is not configured');
    });

    it('should return tags newer than current version sorted descending', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(
        of({ data: { tags: ['1.0.0', '1.1.0', '1.2.0', '0.9.0'] }, status: 200, statusText: 'OK', headers: {}, config: {} } as any),
      );

      const result = await registryService.getTagsSince('ci-os-hub', '1.0.0');

      expect(result).toEqual(['1.2.0', '1.1.0']);
      expect(httpService.get).toHaveBeenCalledWith('https://cloud.ci.computer/v2/ci-os-hub/tags/list');
    });

    it('should return empty array when no newer tags exist', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(of({ data: { tags: ['1.0.0', '0.9.0'] }, status: 200, statusText: 'OK', headers: {}, config: {} } as any));

      const result = await registryService.getTagsSince('ci-os-hub', '1.0.0');

      expect(result).toEqual([]);
    });

    it('should filter out invalid semver tags', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(
        of({ data: { tags: ['latest', 'dev', '1.1.0', 'abc', '1.2.0'] }, status: 200, statusText: 'OK', headers: {}, config: {} } as any),
      );

      const result = await registryService.getTagsSince('ci-os-hub', '1.0.0');

      expect(result).toEqual(['1.2.0', '1.1.0']);
    });

    it('should return empty array on network error', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(throwError(() => new Error('Network error')));

      const result = await registryService.getTagsSince('ci-os-hub', '1.0.0');

      expect(result).toEqual([]);
    });
  });

  describe('getLatestVersion', () => {
    it('should return the latest semver tag', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(
        of({ data: { tags: ['1.0.0', '2.0.0', '1.5.0'] }, status: 200, statusText: 'OK', headers: {}, config: {} } as any),
      );

      const result = await registryService.getLatestVersion('ci-os-hub');

      expect(result).toBe('2.0.0');
    });

    it('should return 0.0.0 when no tags exist', async () => {
      configurationService.get.mockReturnValue('https://cloud.ci.computer');
      httpService.get.mockReturnValue(of({ data: { tags: [] }, status: 200, statusText: 'OK', headers: {}, config: {} } as any));

      const result = await registryService.getLatestVersion('ci-os-hub');

      expect(result).toBe('0.0.0');
    });
  });
});
