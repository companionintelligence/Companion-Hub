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

  describe('setupOrganizationInfrastructure — hubSubdomain handling', () => {
    beforeEach(() => {
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
    });

    it('stores hubSubdomain when creating a new device registration', async () => {
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 't1', token: 'tok1' } as any);
      configService.setDomain.mockResolvedValue(undefined);
      // Mock fetch for tunnel connectivity check
      global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;

      await (service as any).setupOrganizationInfrastructure('org-new', {
        organization_name: 'New Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'device1-neworg',
        slug: 'neworg',
        domain: 'example.com',
      });

      expect(deviceRegistrationRepository.createDeviceRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'org-new',
          hubSubdomain: 'device1-neworg',
        }),
      );
    });

    it('backfills hubSubdomain when existing org is missing it', async () => {
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue({
        id: 'org-existing',
        slug: 'existing',
        name: 'Existing Org',
        tunnelId: 't1',
        tunnelToken: 'tok1',
        hubSubdomain: null,
      } as any);

      await (service as any).setupOrganizationInfrastructure('org-existing', {
        organization_name: 'Existing Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'hub-existing',
        slug: 'existing',
      });

      expect(deviceRegistrationRepository.updateDeviceRegistration).toHaveBeenCalledWith(
        'org-existing',
        expect.objectContaining({ hubSubdomain: 'hub-existing' }),
      );
    });

    it('does NOT overwrite hubSubdomain when existing org already has one', async () => {
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue({
        id: 'org-existing',
        slug: 'existing',
        name: 'Existing Org',
        tunnelId: 't1',
        tunnelToken: 'tok1',
        hubSubdomain: 'already-set',
      } as any);

      await (service as any).setupOrganizationInfrastructure('org-existing', {
        organization_name: 'Existing Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'new-value',
        slug: 'existing',
      });

      const updateCall = deviceRegistrationRepository.updateDeviceRegistration.mock.calls[0];
      if (updateCall) {
        expect(updateCall[1]).not.toHaveProperty('hubSubdomain');
      }
    });
  });

  describe('completeRegistrationFromCallback', () => {
    beforeEach(() => {
      process.env.DEVICE_ID = 'test-device';
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'myhost.example.com',
      } as any);
      (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'test-device' });
    });

    afterEach(() => {
      delete process.env.DEVICE_ID;
    });

    it('returns domain in the success response', async () => {
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.completeRegistrationFromCallback({
        deviceId: 'test-device',
        organizationId: 'org-cb',
        organizationName: 'Callback Org',
        slug: 'cb-org',
        subdomain: 'hub-cb-org',
        tunnelId: 'tunnel-cb',
        tunnelToken: 'token-cb',
        apiKey: 'key-cb',
      });

      expect(result.success).toBe(true);
      expect(result.domain).toBe('myhost.example.com');
      setupSpy.mockRestore();
    });

    it('uses domain from callback data when provided (fixes #190)', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      configService.setDomain.mockResolvedValue(undefined);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.completeRegistrationFromCallback({
        deviceId: 'test-device',
        organizationId: 'org-cb',
        organizationName: 'Callback Org',
        slug: 'cb-org',
        subdomain: 'device-core1',
        tunnelId: 'tunnel-cb',
        tunnelToken: 'token-cb',
        apiKey: 'key-cb',
        domain: 'companionintelligence.com',
      });

      expect(result.success).toBe(true);
      expect(result.domain).toBe('companionintelligence.com');
      expect(configService.setDomain).toHaveBeenCalledWith('companionintelligence.com');
      expect(setupSpy).toHaveBeenCalledWith('org-cb', expect.objectContaining({ domain: 'companionintelligence.com' }));
      setupSpy.mockRestore();
    });

    it('falls back to config domain when callback domain is not provided', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'companionintelligence.com' },
        domain: 'companionintelligence.com',
      } as any);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.completeRegistrationFromCallback({
        deviceId: 'test-device',
        organizationId: 'org-cb',
        organizationName: 'Callback Org',
        slug: 'cb-org',
        subdomain: 'device-core1',
        tunnelId: 'tunnel-cb',
        tunnelToken: 'token-cb',
        apiKey: 'key-cb',
      });

      expect(result.success).toBe(true);
      expect(result.domain).toBe('companionintelligence.com');
      setupSpy.mockRestore();
    });
  });
});
