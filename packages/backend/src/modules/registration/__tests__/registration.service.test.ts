import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
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
  let traefikConfigService: MockProxy<TraefikConfigService>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let repoEventsQueue: MockProxy<RepoEventsQueue>;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    loggerService = mock<LoggerService>();
    cloudflareClientService = mock<CloudflareClientService>();
    traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.writeHubRoute.mockResolvedValue(undefined);
    deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
    repoEventsQueue = mock<RepoEventsQueue>();

    configService.getConfig.mockReturnValue({ ciCloudApiUrl: 'http://cloud.api', domain: 'example.com' } as any);
    (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'uuid-123' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: ConfigurationService, useValue: configService },
        { provide: LoggerService, useValue: loggerService },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: TraefikConfigService, useValue: traefikConfigService },
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
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);

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
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
      } as any);
    });

    afterEach(() => {
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

  describe('pairDevice', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      // Device is not yet registered
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
    });

    it('succeeds with valid pairing code and stores registration data', async () => {
      const portalResponse = {
        device_id: 'test-device',
        organization_id: 'org-pair',
        organization_name: 'Paired Org',
        slug: 'paired-org',
        subdomain: 'hub-paired-org',
        tunnel_id: 'tunnel-pair',
        tunnel_token: 'token-pair',
        api_key: 'key-pair',
        domain: 'companionintelligence.com',
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => portalResponse,
      });
      global.fetch = mockFetch as any;

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);
      configService.setDomain.mockResolvedValue(undefined);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(true);
      expect(result.domain).toBe('companionintelligence.com');
      expect(mockFetch).toHaveBeenCalledWith('http://cloud.api/devices/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairing_code: 'ABC123', device_id: 'test-device' }),
      });
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'key-pair' });
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubOrganizationId: 'org-pair' });
      expect(setupSpy).toHaveBeenCalledWith(
        'org-pair',
        expect.objectContaining({
          organization_name: 'Paired Org',
          tunnel_id: 'tunnel-pair',
          tunnel_token: 'token-pair',
          subdomain: 'hub-paired-org',
          slug: 'paired-org',
          domain: 'companionintelligence.com',
        }),
      );
      setupSpy.mockRestore();
    });

    it('returns error when pairing code is invalid (Portal returns error)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Invalid pairing code' }),
      });
      global.fetch = mockFetch as any;

      const result = await service.pairDevice('XXXXXX');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid pairing code');
    });

    it('returns error when device is already registered', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Device is already registered.');
    });

    it('returns error when Portal is unreachable', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      global.fetch = mockFetch as any;

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unable to reach CI Portal');
    });

    it('returns error when CI Cloud API URL is not configured', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: '',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('CI Cloud API URL not configured.');
    });

    it('returns error when Portal returns incomplete data', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          device_id: 'test-device',
          organization_id: 'org-pair',
          // missing tunnel_id, tunnel_token, subdomain, slug
        }),
      });
      global.fetch = mockFetch as any;

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Portal returned incomplete registration data.');
    });
  });

  describe('completeRegistrationFromCallback', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudApiUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'myhost.example.com',
      } as any);
      (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'test-device' });
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
