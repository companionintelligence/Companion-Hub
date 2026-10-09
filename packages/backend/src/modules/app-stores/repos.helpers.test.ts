import { Test } from '@nestjs/testing';
import { ReposHelpers } from './repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import {
  PORTAL_HTTP_ERROR_CODE,
  PORTAL_STORE_LISTING_TIMEOUT_MS,
  PORTAL_TIMEOUT_CODE,
  PORTAL_UNREACHABLE_CODE,
} from '@/core/portal/portal.constants';
import { RegistrationService } from '../registration/registration.service';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import axios from 'axios';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import fs from 'node:fs';
import path from 'node:path';

// Mock fs module
vi.mock('node:fs', async () => {
  return {
    default: {
      promises: {
        mkdir: vi.fn(),
        chmod: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
        rm: vi.fn(),
        readFile: vi.fn().mockResolvedValue(''),
      },
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(),
      rmdirSync: vi.fn(),
      renameSync: vi.fn(),
      statSync: vi.fn(),
    },
  };
});

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('axios');

describe('ReposHelpers', () => {
  let service: ReposHelpers;
  let configService = mock<ConfigurationService>();
  let filesystemService = mock<FilesystemService>();
  const logger = mockDeep<LoggerService>();
  let registrationService = mock<RegistrationService>();

  const axiosMock = vi.mocked(axios);

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    // @ts-expect-error
    configService.get.mockReturnValue({ dataDir: '/tmp/data' });
    // @ts-expect-error
    configService.getConfig.mockReturnValue({ domain: 'local.test', ciHubApiKey: 'hub-api-key' });

    filesystemService = mock<FilesystemService>();
    filesystemService.pathExists.mockResolvedValue(false);
    filesystemService.removeDirectory.mockResolvedValue(true);

    registrationService = mock<RegistrationService>();
    registrationService.getDeviceId.mockResolvedValue('test-uuid');

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReposHelpers,
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: logger },
        { provide: RegistrationService, useValue: registrationService },
      ],
    }).compile();

    service = moduleRef.get<ReposHelpers>(ReposHelpers);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('pullRepo with ci_cloud_api', () => {
    it('should fetch apps metadata and write config.json', async () => {
      const appsData = [
        { slug: 'app1', name: 'App 1', version: '1.0.0' },
        { slug: 'app2', name: 'App 2', version: '1.0.0' },
      ];

      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: appsData,
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(axiosMock.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'http://cloud.api/store',
          params: expect.objectContaining({ _ts: expect.any(String) }),
          headers: expect.objectContaining({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' }),
        }),
      );

      // Verify it creates directories and writes files
      expect(fs.promises.mkdir).toHaveBeenCalled();
      // We expect writes for each app's config.json
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('app1/config.json')),
        expect.stringContaining('"slug": "app1"'),
      );
    });

    it('should enrich missing metadata for CI Cloud apps', async () => {
      const minimalApp = {
        id: 'app1',
        slug: 'app1',
        name: 'App 1',
        // Missing author, urn, etc.
      };

      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [minimalApp],
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(axiosMock.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: 'http://cloud.api/store' }));

      const calls = (fs.promises.writeFile as any).mock.calls;
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));
      expect(configCall).toBeDefined();

      const writtenConfig = JSON.parse(configCall[1]);

      // Check enriched fields
      expect(writtenConfig).toHaveProperty('urn', 'urn:app:app1');
      expect(writtenConfig).toHaveProperty('author', 'Unknown Author');
      expect(writtenConfig).toHaveProperty('available', true);
      expect(writtenConfig).toHaveProperty('categories', ['utilities']);
      expect(writtenConfig).toHaveProperty('port', 8080);
      expect(writtenConfig).toHaveProperty('supported_architectures', ['amd64', 'arm64']);
    });

    it('uses metadata/description.md for the full app description', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [{ id: 'app1', slug: 'app1', name: 'App 1', description: 'Config fallback description' }],
      });

      axiosMock.get.mockImplementation(async (url: string) => {
        if (url === 'http://cloud.api/store/app1/metadata/description.md') {
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
            data: '# Markdown description',
          };
        }

        return {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          data: '',
        };
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const descriptionCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/metadata/description.md')));
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));

      expect(descriptionCall).toBeDefined();
      expect(descriptionCall[1]).toBe('# Markdown description');
      expect(JSON.parse(configCall[1]).description).toBe('# Markdown description');
    });

    it('falls back to config description for unsupported description content-types', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [{ id: 'app1', slug: 'app1', name: 'App 1', description: 'Config fallback description' }],
      });

      axiosMock.get.mockImplementation(async (url: string) => {
        if (url === 'http://cloud.api/store/app1/metadata/description.md') {
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            data: '<html>wrong payload</html>',
          };
        }

        return {
          status: 404,
          statusText: 'Not Found',
          headers: {},
          data: '',
        };
      });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const descriptionCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/metadata/description.md')));
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));

      expect(descriptionCall).toBeUndefined();
      expect(JSON.parse(configCall[1]).description).toBe('Config fallback description');
    });

    it('skips re-downloading apps whose local config matches the published catalog entry', async () => {
      const compose = JSON.stringify({ schemaVersion: 2, services: [] });
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [
          {
            id: 'app1',
            slug: 'app1',
            name: 'App 1',
            version: '1.0.0',
            cihub_app_version: 3,
            updated_at: 100,
            supported_architectures: ['amd64'],
            compose,
          },
        ],
      });
      (fs.promises.readFile as any).mockImplementation(async (filePath: string) => {
        if (String(filePath).includes('docker-compose.json')) {
          return compose;
        }
        return JSON.stringify({
          cihub_app_version: 3,
          version: '1.0.0',
          available: true,
          updated_at: 100,
          supported_architectures: ['amd64'],
        });
      });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(true);
      const calls = (fs.promises.writeFile as any).mock.calls;
      expect(calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')))).toBeUndefined();
      // No description/icon fetches for an unchanged app
      expect(axiosMock.get).not.toHaveBeenCalled();
    });

    it('re-syncs an app when the published version differs from the local config', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [{ id: 'app1', slug: 'app1', name: 'App 1', version: '2.0.0', cihub_app_version: 4 }],
      });
      (fs.promises.readFile as any).mockResolvedValue(JSON.stringify({ cihub_app_version: 3, version: '1.0.0', available: true }));
      axiosMock.get.mockResolvedValue({ status: 404, statusText: 'Not Found', headers: {}, data: '' });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('app1/config.json')));
      expect(configCall).toBeDefined();
      expect(JSON.parse(configCall[1]).cihub_app_version).toBe(4);
    });

    it('re-syncs when version is unchanged but updated_at / architectures / compose drift', async () => {
      const localCompose = JSON.stringify({ schemaVersion: 2, services: [{ name: 'old' }] });
      const portalCompose = JSON.stringify({ schemaVersion: 2, services: [{ name: 'new' }] });
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [
          {
            id: 'cal',
            slug: 'cal',
            name: 'Cal.diy',
            version: 'latest',
            cihub_app_version: 2,
            updated_at: 200,
            supported_architectures: ['amd64', 'arm64'],
            runtime_platform: 'linux/amd64',
            compose: portalCompose,
          },
        ],
      });
      (fs.promises.readFile as any).mockImplementation(async (filePath: string) => {
        if (String(filePath).includes('docker-compose.json')) {
          return localCompose;
        }
        return JSON.stringify({
          cihub_app_version: 2,
          version: 'latest',
          available: true,
          updated_at: 100,
          supported_architectures: ['amd64'],
        });
      });
      axiosMock.get.mockResolvedValue({ status: 404, statusText: 'Not Found', headers: {}, data: '' });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      const calls = (fs.promises.writeFile as any).mock.calls;
      const configCall = calls.find((call: any[]) => call[0].includes(path.normalize('cal/config.json')));
      expect(configCall).toBeDefined();
      expect(JSON.parse(configCall[1]).supported_architectures).toEqual(['amd64', 'arm64']);
      expect(JSON.parse(configCall[1]).runtime_platform).toBe('linux/amd64');
    });

    it('retries transient CI Cloud HTTP failures before succeeding', async () => {
      axiosMock.request
        .mockResolvedValueOnce({ status: 503, statusText: 'Service Unavailable', data: {} })
        .mockResolvedValueOnce({ status: 200, statusText: 'OK', data: [] });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(true);
      expect(axiosMock.request).toHaveBeenCalledTimes(2);
    });

    it('does not retry permanent CI Cloud client errors', async () => {
      axiosMock.request.mockResolvedValueOnce({ status: 404, statusText: 'Not Found', data: {} });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(false);
      expect(result.message).toContain('404 Not Found');
      expect(axiosMock.request).toHaveBeenCalledTimes(1);
    });

    describe('transport failures', () => {
      const transportError = (code: string, message: string) => Object.assign(new Error(message), { isAxiosError: true, code });

      beforeEach(() => {
        vi.mocked(axios.isAxiosError).mockImplementation(((error: unknown) =>
          Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError)) as typeof axios.isAxiosError);
      });

      afterEach(() => {
        vi.mocked(axios.isAxiosError).mockReset();
      });

      it('does not retry a store listing that used up its whole timeout', async () => {
        axiosMock.request.mockRejectedValueOnce(transportError('ECONNABORTED', 'timeout of 45000ms exceeded'));

        const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

        expect(result.success).toBe(false);
        expect(result.message).toContain('timeout of 45000ms exceeded');
        // One 45s attempt, not three: a manual Check for Updates would otherwise wait ~135s.
        expect(axiosMock.request).toHaveBeenCalledTimes(1);
      });

      it('still retries a store listing whose connection failed', async () => {
        axiosMock.request
          .mockRejectedValueOnce(transportError('ECONNRESET', 'socket hang up'))
          .mockResolvedValueOnce({ status: 200, statusText: 'OK', data: [] });

        const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

        expect(result.success).toBe(true);
        expect(axiosMock.request).toHaveBeenCalledTimes(2);
      });

      it('says why the store listing failed when no address of the Portal accepted the connection', async () => {
        // That error's message is empty, so the sync logged only axios's stack and reported nothing.
        axiosMock.request.mockRejectedValue(axiosEveryAddressFailed());

        const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

        expect(result).toEqual({ success: false, message: EVERY_ADDRESS_FAILED, errorCode: PORTAL_UNREACHABLE_CODE });
        expect(logger.error).toHaveBeenCalledWith(`CI Cloud request failed: ${EVERY_ADDRESS_FAILED}`);
      });
    });
  });

  describe('CI Marketplace catalog index', () => {
    const INDEX_PATH = path.join('/tmp/data', 'repos', 'ci-marketplace', 'catalog-index.json');
    const isIndexTmp = (filePath: unknown) => String(filePath).startsWith(`${INDEX_PATH}.`) && String(filePath).endsWith('.tmp');
    const indexWrites = () => vi.mocked(fs.promises.writeFile).mock.calls.filter(([filePath]) => isIndexTmp(filePath));

    it('records exactly the listed slugs and their Portal after a complete sync', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [
          { slug: 'app1', name: 'App 1' },
          { id: 'app2', name: 'App 2' },
          { slug: '../escape', name: 'Escape' },
        ],
      });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(true);
      expect(indexWrites()).toHaveLength(1);
      const [indexWrite] = indexWrites();
      expect(JSON.parse(String(indexWrite?.[1]))).toMatchObject({ version: 1, source: 'http://cloud.api', slugs: ['app1', 'app2'] });
      expect(fs.promises.rename).toHaveBeenCalledWith(indexWrite?.[0], INDEX_PATH);
      // The unsafe slug is neither indexed nor written outside `apps/`.
      const escaped = path.join('/tmp/data', 'repos', 'ci-marketplace', 'escape');
      expect(vi.mocked(fs.promises.writeFile).mock.calls.some(([filePath]) => String(filePath).startsWith(escaped))).toBe(false);
      expect(vi.mocked(fs.promises.mkdir).mock.calls.some(([dirPath]) => String(dirPath).startsWith(escaped))).toBe(false);
    });

    it('indexes only the listed apps whose folders synced when another app fails', async () => {
      axiosMock.request.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: [
          { slug: 'app1', name: 'App 1' },
          { slug: 'app2', name: 'App 2' },
        ],
      });
      // app2's folder cannot be written (e.g. owned by another user); app1 syncs.
      vi.mocked(fs.promises.writeFile).mockImplementation(async (filePath) => {
        if (String(filePath).includes(`${path.sep}app2${path.sep}`)) {
          throw new Error('EACCES');
        }
      });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      // The sync still reports the failure...
      expect(result.success).toBe(false);
      expect(result.message).toContain('EACCES');
      // ...but the index is replaced, so an older one naming apps Portal has since withdrawn does not
      // outlive a single app that keeps failing. The failed app is left out rather than served stale.
      expect(indexWrites()).toHaveLength(1);
      expect(JSON.parse(String(indexWrites()[0]?.[1]))).toMatchObject({ source: 'http://cloud.api', slugs: ['app1'] });
      expect(fs.promises.rename).toHaveBeenCalledWith(indexWrites()[0]?.[0], INDEX_PATH);
    });

    it('removes the previous index when the new one cannot be written', async () => {
      axiosMock.request.mockResolvedValue({ status: 200, statusText: 'OK', data: [{ slug: 'app1', name: 'App 1' }] });
      vi.mocked(fs.promises.rename).mockRejectedValueOnce(new Error('EACCES'));

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(true);
      expect(fs.promises.rm).toHaveBeenCalledWith(INDEX_PATH, { force: true });
    });

    it('does not write an index when Portal does not answer with a listing', async () => {
      axiosMock.request.mockResolvedValue({ status: 200, statusText: 'OK', data: { error: 'maintenance' } });

      const result = await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(result.success).toBe(false);
      expect(indexWrites()).toHaveLength(0);
    });

    it('gives each index write its own temporary file so overlapping syncs cannot clobber each other', async () => {
      axiosMock.request.mockResolvedValue({ status: 200, statusText: 'OK', data: [{ slug: 'app1', name: 'App 1' }] });

      await Promise.all([
        service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api'),
        service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api'),
      ]);

      const tmpPaths = indexWrites().map(([filePath]) => filePath);
      expect(tmpPaths).toHaveLength(2);
      expect(new Set(tmpPaths).size).toBe(2);
    });

    it('gives the store listing a timeout above the observed Portal build time', async () => {
      axiosMock.request.mockResolvedValue({ status: 200, statusText: 'OK', data: [] });

      await service.pullRepo('http://cloud.api', 'ci-marketplace', 'ci_cloud_api');

      expect(axiosMock.request).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://cloud.api/store', timeout: PORTAL_STORE_LISTING_TIMEOUT_MS }),
      );
      expect(PORTAL_STORE_LISTING_TIMEOUT_MS).toBeGreaterThan(37_000);
    });
  });

  describe('downloadAppFiles', () => {
    it('should fetch install files and write them', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'docker-compose.yml': 'services: test',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

      expect(result.success).toBe(true);
      expect(axiosMock.get).toHaveBeenCalledWith(
        'http://cloud.api/store/app1/install',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-device-id': 'test-uuid',
            Authorization: 'Bearer hub-api-key',
            'x-device-key': 'hub-api-key',
          }),
        }),
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.yml'), 'services: test');
    });

    it('should write multiple files from files format', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'config.json': '{"name":"test"}',
            'docker-compose.json': 'services:\n  app:\n    image: test',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'multi-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('config.json'), '{"name":"test"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining('docker-compose.json'), 'services:\n  app:\n    image: test');
    });

    it('should handle canonical files format with multiple files', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: {
            'docker-compose.yml': 'services:\n  app:\n    image: nginx',
            'config.json': '{"name":"multi"}',
            'data/settings.json': '{"key":"value"}',
          },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'multi-file-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(3);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('multi-file-app/docker-compose.yml')),
        'services:\n  app:\n    image: nginx',
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.normalize('multi-file-app/config.json')), '{"name":"multi"}');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.normalize('multi-file-app/data/settings.json')),
        '{"key":"value"}',
      );

      // Verify mkdir is called for nested paths (data/ subdirectory)
      const mkdirCalls = (fs.promises.mkdir as any).mock.calls.map((c: any[]) => c[0]);
      expect(mkdirCalls).toContainEqual(expect.stringContaining(path.normalize('multi-file-app/data')));
    });

    it('should reject responses that do not contain a files object', async () => {
      axiosMock.get.mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        data: {},
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'bad-app');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to fetch app files');
    });

    // #1912: a customer hub's n8n install reached Sentry as COMMON_AN_ERROR_OCCURRED with nothing
    // else, because the only description of the Portal failure was a message the caller threw away.
    // Each way the bundle fetch can fail now also names its cause in `errorCode`.
    describe('names why the install bundle could not be fetched', () => {
      const transportError = (code: string, message: string) => Object.assign(new Error(message), { isAxiosError: true, code });

      beforeEach(() => {
        vi.mocked(axios.isAxiosError).mockImplementation(((error: unknown) =>
          Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError)) as typeof axios.isAxiosError);
      });

      afterEach(() => {
        vi.mocked(axios.isAxiosError).mockReset();
      });

      it('a Portal status it has no handling for is a Portal HTTP error, with the status in the message', async () => {
        axiosMock.get.mockResolvedValue({ status: 503, statusText: 'Service Unavailable', data: { error: 'Entitlement check unavailable' } });

        const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

        expect(result).toEqual({ success: false, message: 'Failed to fetch app files: 503 Service Unavailable', errorCode: PORTAL_HTTP_ERROR_CODE });
        expect(logger.error).toHaveBeenCalledWith('CI Cloud request failed: Failed to fetch app files: 503 Service Unavailable');
      });

      it('the 20s client timeout elapsing is a Portal timeout', async () => {
        axiosMock.get.mockRejectedValue(transportError('ECONNABORTED', 'timeout of 20000ms exceeded'));

        const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

        expect(result).toEqual({ success: false, message: 'timeout of 20000ms exceeded (ECONNABORTED)', errorCode: PORTAL_TIMEOUT_CODE });
      });

      it('a connection that never formed is Portal unreachable', async () => {
        axiosMock.get.mockRejectedValue(axiosEveryAddressFailed());

        const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

        expect(result).toEqual({ success: false, message: EVERY_ADDRESS_FAILED, errorCode: PORTAL_UNREACHABLE_CODE });
      });

      it('a name that does not resolve is Portal unreachable', async () => {
        const error = Object.assign(new Error('getaddrinfo ENOTFOUND hub.ci.computer'), {
          isAxiosError: true,
          code: 'ENOTFOUND',
          syscall: 'getaddrinfo',
          hostname: 'hub.ci.computer',
        });
        axiosMock.get.mockRejectedValue(error);

        const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');

        expect(result.success).toBe(false);
        expect(result.message).toContain('getaddrinfo ENOTFOUND hub.ci.computer');
        expect(result.success === false && result.errorCode).toBe(PORTAL_UNREACHABLE_CODE);
      });

      it('an auth or payment status keeps its translation key and carries no Portal error code', async () => {
        axiosMock.get.mockResolvedValue({ status: 402, statusText: 'Payment Required', data: {} });

        const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'paid-app');

        expect(result).toEqual({ success: false, message: 'APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED' });
      });
    });

    it('should handle empty files object gracefully', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { files: {} },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'empty-app');

      expect(result.success).toBe(true);
      // No writeFile calls for app content (only mkdir/chmod for dir setup)
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should handle response with no files property (warn, not crash)', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: { someOtherData: 'hello' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'no-files-app');

      expect(result.success).toBe(true);
      expect(result.message).toBe('App files downloaded');
      // Should log warning but not write any files
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('MUST NOT support legacy {config, dockerCompose} format', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          config: '{"name":"legacy"}',
          dockerCompose: 'services:\n  app:\n    image: old',
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'legacy-app');

      // Should succeed but write no files (legacy format not recognized)
      expect(result.success).toBe(true);
      const writeFileCalls = (fs.promises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBe(0);
    });

    it('should pass through file content exactly as received (no transformation)', async () => {
      const exactContent = '  spaces  \n\ttabs\t\n{"json": true}\nspecial chars: àéîõü™©®';
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: { 'exact.txt': exactContent },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'exact-app');

      expect(result.success).toBe(true);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining(path.normalize('exact-app/exact.txt')), exactContent);
    });

    it('should create directories before writing files', async () => {
      axiosMock.get.mockResolvedValue({
        status: 200,
        statusText: 'OK',
        data: {
          files: { 'test.yml': 'content' },
        },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'repo1', 'dir-app');

      expect(result.success).toBe(true);
      // mkdir should be called before writeFile (ensureDirectoryWithPermissions)
      expect(fs.promises.mkdir).toHaveBeenCalled();
      expect(fs.promises.writeFile).toHaveBeenCalled();

      // Verify mkdir was called before writeFile
      const mkdirOrder = (fs.promises.mkdir as any).mock.invocationCallOrder[0];
      const writeFileOrder = (fs.promises.writeFile as any).mock.invocationCallOrder[0];
      expect(mkdirOrder).toBeLessThan(writeFileOrder);
    });

    it('should handle payment required', async () => {
      axiosMock.get.mockResolvedValue({
        status: 402,
        statusText: 'Payment Required',
        data: { error: 'Payment Required' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'paid-app');
      expect(result.success).toBe(false);
      expect(result.message).toBe('APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED');
    });

    it('should map portal 401 to a translatable install error key', async () => {
      axiosMock.get.mockResolvedValue({
        status: 401,
        statusText: 'Unauthorized',
        data: { error: 'Unauthorized' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');
      expect(result.success).toBe(false);
      expect(result.message).toBe('APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED');
    });

    it('should map portal 403 to a translatable install error key', async () => {
      axiosMock.get.mockResolvedValue({
        status: 403,
        statusText: 'Forbidden',
        data: { error: 'Forbidden' },
      });

      const result = await service.downloadAppFiles('http://cloud.api', 'ci-marketplace', 'app1');
      expect(result.success).toBe(false);
      expect(result.message).toBe('APP_INSTALL_PORTAL_DOWNLOAD_FORBIDDEN');
    });
  });
  describe('repo id containment', () => {
    // A store slug has been user-supplied, and `repos/..` is the data directory itself: the
    // filesystem fence allows anything under DATA_DIR, so it is this check that stands between
    // a slug and a recursive delete of everything the Hub keeps.
    const ESCAPING_IDS = ['..', '.', '', '../state', '../../etc', 'a/b', 'a/../..', '/etc'];

    it.each(ESCAPING_IDS)('deleteRepo(%j) removes nothing', async (id) => {
      filesystemService.pathExists.mockResolvedValue(true);

      await service.deleteRepo(id);

      expect(filesystemService.removeDirectory).not.toHaveBeenCalled();
    });

    it.each(ESCAPING_IDS)('cloneRepo(%j) touches nothing outside repos/', async (id) => {
      filesystemService.pathExists.mockResolvedValue(false);

      const result = await service.cloneRepo('https://example.com/repo.git', id);

      expect(result.success).toBe(false);
      expect(filesystemService.createDirectory).not.toHaveBeenCalled();
      expect(fs.promises.mkdir).not.toHaveBeenCalled();
    });

    it('deleteRepo removes an ordinary store folder', async () => {
      filesystemService.pathExists.mockResolvedValue(true);

      const result = await service.deleteRepo('my-store');

      expect(result.success).toBe(true);
      expect(filesystemService.removeDirectory).toHaveBeenCalledWith(path.resolve('/tmp/data', 'repos', 'my-store'));
    });
  });
});
