import { Test, TestingModule } from '@nestjs/testing';
import { CloudflareClientService } from '../cloudflare-client.service';
import { APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModuleRef } from '@nestjs/core';
import { DockerService } from '@/modules/docker/docker.service';
import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('axios');
vi.mock('node:fs/promises');
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('CloudflareClientService', () => {
  let service: CloudflareClientService;
  let configService: MockProxy<ConfigurationService>;
  let moduleRef: MockProxy<ModuleRef>;
  let dockerService: MockProxy<DockerService>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLocal = process.env.LOCAL;

  // Axios mock
  const mockedAxios = vi.mocked(axios);
  const mockAxiosInstance = {
    post: vi.fn(),
    get: vi.fn(),
  } as any;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    moduleRef = mock<ModuleRef>();
    dockerService = mock<DockerService>();

    configService.get.mockImplementation((key) => {
      if (key === 'ciCloudUrl') return 'http://api.cloud';
      if (key === 'ciHubApiKey') return 'api-key';
      return null;
    });

    moduleRef.get.mockReturnValue(dockerService);
    (mockedAxios.create as any).mockReturnValue(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [CloudflareClientService, { provide: ConfigurationService, useValue: configService }, { provide: ModuleRef, useValue: moduleRef }],
    }).compile();

    service = module.get<CloudflareClientService>(CloudflareClientService);
  });

  afterEach(() => {
    vi.clearAllMocks();

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalLocal === undefined) {
      delete process.env.LOCAL;
    } else {
      process.env.LOCAL = originalLocal;
    }
  });

  describe('initializeTunnel', () => {
    it('should use the mounted runtime compose file when available', async () => {
      vi.mocked(fsSync.existsSync).mockReturnValue(true);

      const result = await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('tunnel/token'), 'tok', { mode: 0o644 });
      expect(fsSync.existsSync).toHaveBeenCalledWith(`${DATA_DIR}/docker-compose.yml`);
      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: `${DATA_DIR}/docker-compose.yml`,
        profile: 'cloudflare',
      });
      expect(result).toEqual({ tunnelId: 'tun-id', token: 'tok' });
    });

    it('should fall back to the source prod compose file when the mounted runtime compose file is unavailable', async () => {
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: `${APP_DIR}/docker-compose.prod.yml`,
        profile: 'cloudflare',
      });
    });

    it('should use the local compose file when in dev mode and no mounted compose file is present', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: `${APP_DIR}/docker-compose.local.yml`,
        profile: 'cloudflare',
      });
    });

    it('should fail if no credentials', async () => {
      const result = await service.initializeTunnel('org-id', { tunnelId: '', token: '' });
      expect(result).toBeNull();
    });

    it('should skip cloudflared container start in local/E2E mode (ci.localhost)', async () => {
      configService.get.mockImplementation((key) => {
        if (key === 'ciCloudUrl') return 'http://api.cloud';
        if (key === 'ciHubApiKey') return 'api-key';
        if (key === 'domain') return 'ci.localhost';
        return null;
      });

      const result = await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      // Token file should still be written
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('tunnel/token'), 'tok', { mode: 0o644 });
      // Docker container should NOT be started
      expect(dockerService.ensureContainerRunning).not.toHaveBeenCalled();
      // Should still return credentials
      expect(result).toEqual({ tunnelId: 'tun-id', token: 'tok' });
    });
  });

  describe('syncState', () => {
    it('should post apps to cloud', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result).toBe(true);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'tunnels/state',
        expect.objectContaining({ organizationId: 'org-id', tunnelId: 'tun-id' }),
        expect.anything(),
      );
    });

    it('should fail if no tunnelId', async () => {
      const result = await service.syncState('org-id', []);
      expect(result).toBe(false);
    });

    it('should handle axios error', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Network Error'));
      const result = await service.syncState('org-id', [], 'tun-id');
      expect(result).toBe(false);
    });
  });

  describe('fetchAvailableDomains', () => {
    it('should normalize numeric domain ids to strings', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          domains: [
            { id: 1, domain: 'example.com', isDefault: true, scope: 'org' },
            { id: '2', domain: 'ci.computer', isDefault: false },
          ],
        },
      });

      const result = await service.fetchAvailableDomains();

      expect(result).toEqual({
        domains: [
          { id: '1', domain: 'example.com', isDefault: true, scope: 'org' },
          { id: '2', domain: 'ci.computer', isDefault: false },
        ],
      });
    });

    it('should retry cloudflare/domains when domains endpoint returns 404', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({
        data: {
          domains: [{ id: '1', domain: 'example.com', isDefault: true }],
        },
      });

      const result = await service.fetchAvailableDomains();

      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, 'domains', expect.anything());
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, 'cloudflare/domains', expect.anything());
      expect(result).toEqual({
        domains: [{ id: '1', domain: 'example.com', isDefault: true }],
      });
    });
  });
});
