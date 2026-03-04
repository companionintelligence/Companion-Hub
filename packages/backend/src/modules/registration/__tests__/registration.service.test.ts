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

  describe('checkRegistrationWithCloud — polling enabled', () => {
    beforeEach(() => {
      process.env.DEVICE_ID = 'test-device';
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
      } as any);
    });

    afterEach(() => {
      delete process.env.DEVICE_ID;
      delete process.env.LOCAL;
      delete process.env.API_PORT;
    });

    it('returns true when ciCloudApiUrl is not configured', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: '',
        userSettings: { domain: 'example.com' },
      } as any);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(true);
    });

    it('returns false when registration not found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ registered: false }),
      });
      global.fetch = mockFetch as any;

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('returns false when registration is not ready', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ registered: true, ready: false }),
      });
      global.fetch = mockFetch as any;

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('persists config and initializes infra when registration is ready', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          registered: true,
          ready: true,
          organization_id: 'org-123',
          organization_name: 'Test Org',
          slug: 'test-org',
          subdomain: 'hub-test-org',
          tunnel_id: 'tunnel-123',
          tunnel_token: 'token-123',
          api_key: 'api-123',
          domain: 'example.com',
        }),
      });
      global.fetch = mockFetch as any;

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(true);
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'api-123' });
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubOrganizationId: 'org-123' });
      expect(setupSpy).toHaveBeenCalledWith('org-123', {
        organization_name: 'Test Org',
        tunnel_id: 'tunnel-123',
        tunnel_token: 'token-123',
        subdomain: 'hub-test-org',
        slug: 'test-org',
        domain: 'example.com',
      });
    });
  });
});
