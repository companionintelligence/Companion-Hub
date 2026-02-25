import { Test, TestingModule } from '@nestjs/testing';
import { CloudflareClientService } from '../cloudflare-client.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModuleRef } from '@nestjs/core';
import { DockerService } from '@/modules/docker/docker.service';
import axios from 'axios';
import * as fs from 'node:fs/promises';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('axios');
vi.mock('node:fs/promises');

describe('CloudflareClientService', () => {
  let service: CloudflareClientService;
  let configService: MockProxy<ConfigurationService>;
  let moduleRef: MockProxy<ModuleRef>;
  let dockerService: MockProxy<DockerService>;

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
      if (key === 'ciCloudApiUrl') return 'http://api.cloud';
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
  });

  describe('initializeTunnel', () => {
    it('should write token and ensure cloudflared is running', async () => {
      const result = await service.initializeTunnel('org-id', { tunnelId: 'tun-id', token: 'tok' });

      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('tunnel/token'), 'tok');
      expect(dockerService.ensureContainerRunning).toHaveBeenCalledWith('cloudflared', {
        composeFile: expect.stringContaining('docker-compose.'),
        profile: 'cloudflare',
      });
      expect(result).toEqual({ tunnelId: 'tun-id', token: 'tok' });
    });

    it('should fail if no credentials', async () => {
      const result = await service.initializeTunnel('org-id', { tunnelId: '', token: '' });
      expect(result).toBeNull();
    });
  });

  describe('syncState', () => {
    it('should post apps to cloud', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      const result = await service.syncState('org-id', [], 'tun-id');

      expect(result).toBe(true);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/tunnels/state',
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
});
