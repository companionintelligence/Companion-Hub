import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as si from 'systeminformation';

vi.mock('systeminformation');

describe('RegistrationService', () => {
  let service: RegistrationService;
  let configService: MockProxy<ConfigurationService>;
  let loggerService: MockProxy<LoggerService>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let repoEventsQueue: MockProxy<RepoEventsQueue>;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    loggerService = mock<LoggerService>();
    cloudflareClientService = mock<CloudflareClientService>();
    deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
    repoEventsQueue = mock<RepoEventsQueue>();

    configService.getConfig.mockReturnValue({ ciCloudApiUrl: 'http://cloud.api' } as any);
    (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'uuid-123' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: ConfigurationService, useValue: configService },
        { provide: LoggerService, useValue: loggerService },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: DeviceRegistrationRepository, useValue: deviceRegistrationRepository },
        { provide: RepoEventsQueue, useValue: repoEventsQueue },
      ],
    }).compile();

    service = module.get<RegistrationService>(RegistrationService);
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isRegistered', () => {
    it('should return true if device is registered', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);

      const result = await (service as any).isRegistered();
      expect(result).toBe(true);
    });

    it('should return false if no registration found', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      const result = await (service as any).isRegistered();
      expect(result).toBe(false);
    });
  });

  describe('verifyLicense', () => {
    it('should skip license verification', async () => {
      await (service as any).verifyLicense();

      expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('License verification skipped'));
    });
  });

  describe('checkRegistrationWithCloud — port in registration body', () => {
    beforeEach(() => {
      process.env.DEVICE_ID = 'test-device';
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        ciHubOrganizationId: 'org-123',
        ciHubApiKey: 'key-123',
        userSettings: { domain: 'example.com' },
      } as any);
    });

    afterEach(() => {
      delete process.env.DEVICE_ID;
      delete process.env.LOCAL;
      delete process.env.API_PORT;
    });

    it('MUST send port: 9091 in registration body when LOCAL=true', async () => {
      process.env.LOCAL = 'true';
      delete process.env.API_PORT;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          device_id: 'test',
          status: 'registered',
          organization_name: 'test',
          slug: 'test',
          tunnel_id: 't1',
          tunnel_token: 'tk1',
          subdomain: 'sub1',
        }),
      });
      global.fetch = mockFetch as any;

      await (service as any).checkRegistrationWithCloud();

      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.port).toBe(9091);
    });

    it('MUST send port: API_PORT value when LOCAL is not true', async () => {
      delete process.env.LOCAL;
      process.env.API_PORT = '4000';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          device_id: 'test',
          status: 'registered',
          organization_name: 'test',
          slug: 'test',
          tunnel_id: 't1',
          tunnel_token: 'tk1',
          subdomain: 'sub1',
        }),
      });
      global.fetch = mockFetch as any;

      await (service as any).checkRegistrationWithCloud();

      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.port).toBe(4000);
    });

    it('MUST default to port 3000 when API_PORT is not set and LOCAL is not true', async () => {
      delete process.env.LOCAL;
      delete process.env.API_PORT;

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          device_id: 'test',
          status: 'registered',
          organization_name: 'test',
          slug: 'test',
          tunnel_id: 't1',
          tunnel_token: 'tk1',
          subdomain: 'sub1',
        }),
      });
      global.fetch = mockFetch as any;

      await (service as any).checkRegistrationWithCloud();

      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.port).toBe(3000);
    });
  });
});
