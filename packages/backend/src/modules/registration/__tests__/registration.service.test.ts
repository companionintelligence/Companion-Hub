import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import axios from 'axios';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as si from 'systeminformation';

vi.mock('systeminformation');
vi.mock('axios');

describe('RegistrationService', () => {
  let service: RegistrationService;
  let configService: MockProxy<ConfigurationService>;
  let loggerService: MockProxy<LoggerService>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;
  let traefikConfigService: MockProxy<TraefikConfigService>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let repoEventsQueue: MockProxy<RepoEventsQueue>;
  const mockedAxios = vi.mocked(axios);

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    loggerService = mock<LoggerService>();
    cloudflareClientService = mock<CloudflareClientService>();
    traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.writeHubRoute.mockResolvedValue(undefined);
    deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
    repoEventsQueue = mock<RepoEventsQueue>();
    mockedAxios.post.mockReset();
    mockedAxios.head.mockReset();

    configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', domain: 'example.com' } as any);
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
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'locally_ready',
        degradedReasons: '[]',
      } as any);
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

  describe('getRegistrationStatus', () => {
    it('returns unregistered phase by default', () => {
      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('unregistered');
      expect(status.registered).toBe(false);
      expect(status.degradedReasons).toEqual([]);
    });

    it('returns correct status after setPhase', async () => {
      // setPhase requires a legal transition, start from unregistered → paired
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);

      await service.setPhase('paired');
      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('paired');
      expect(status.registered).toBe(false);
    });

    it('includes degradedReasons when phase is degraded', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);

      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['tunnel_unreachable']);

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('degraded');
      expect(status.degradedReasons).toEqual(['tunnel_unreachable']);
      expect(status.registered).toBe(true);
    });

    it('refreshes from persisted state before returning live status', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'locally_ready',
        degradedReasons: '[]',
      } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);

      await service.getLiveRegistrationStatus();
      await (service as any).phaseRefreshInFlight;
      const status = service.getRegistrationStatus();

      expect(status.phase).toBe('locally_ready');
      expect(status.registered).toBe(true);
    });

    it('returns cached phase immediately and refreshes from sources in the background', async () => {
      const refreshSpy = vi.spyOn(service as any, 'refreshPhaseFromSources').mockResolvedValue(undefined);

      const status = await service.getLiveRegistrationStatus();
      expect(status.phase).toBe('unregistered');
      expect(refreshSpy).toHaveBeenCalledOnce();

      refreshSpy.mockClear();
      (service as any).phaseReadCachedAt = Date.now();
      await service.getLiveRegistrationStatus();
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('throttles background refresh retries after a failed refresh', async () => {
      const refreshSpy = vi.spyOn(service as any, 'refreshPhaseFromSources').mockRejectedValue(new Error('db unavailable'));

      await service.getLiveRegistrationStatus();
      await (service as any).phaseRefreshInFlight;
      expect(refreshSpy).toHaveBeenCalledOnce();

      refreshSpy.mockClear();
      await service.getLiveRegistrationStatus();
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('resets stale operational cache to unregistered when DB row and tunnel token are both missing', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);
      (service as any).phaseReadCachedAt = 0;

      await service.getLiveRegistrationStatus();
      await (service as any).phaseRefreshInFlight;
      const status = service.getRegistrationStatus();

      expect(status.phase).toBe('unregistered');
      expect(status.registered).toBe(false);
    });
  });

  describe('setPhase', () => {
    beforeEach(() => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
    });

    it('persists phase to database', async () => {
      await service.setPhase('paired');
      expect(deviceRegistrationRepository.updateProvisioningState).toHaveBeenCalledWith('org-1', 'paired', []);
    });

    it('ignores illegal transitions', async () => {
      // unregistered → publicly_ready is illegal
      await service.setPhase('publicly_ready');
      expect(service.getRegistrationStatus().phase).toBe('unregistered');
    });

    it('allows idempotent no-op transitions', async () => {
      // Phase is already unregistered, setting it again should be a no-op
      await service.setPhase('unregistered');
      expect(deviceRegistrationRepository.updateProvisioningState).not.toHaveBeenCalled();
    });

    it('allows reset to unregistered from any phase', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
      await service.setPhase('unregistered');
      expect(service.getRegistrationStatus().phase).toBe('unregistered');
    });
  });

  describe('verifyLicense', () => {
    it('should skip license verification', async () => {
      await (service as any).verifyLicense();
      // License verification is not currently implemented — just returns
    });
  });

  describe('checkRegistrationWithCloud — polling enabled', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'test-api-key',
        userSettings: { domain: 'example.com' },
      } as any);
    });

    afterEach(() => {
      delete process.env.LOCAL;
      delete process.env.API_PORT;
    });

    it('returns true when ciCloudUrl is not configured', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudUrl: '',
        userSettings: { domain: 'example.com' },
      } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(true);
    });

    it('returns false when registration not found', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('returns false when registration is incomplete (missing tunnelId)', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-123',
        name: 'Test Org',
        slug: 'test-org',
        hubSubdomain: 'hub-test-org',
        tunnelId: null,
        tunnelToken: 'token-123',
      } as any);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('returns false when registration is incomplete (missing hubSubdomain)', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-123',
        name: 'Test Org',
        slug: 'test-org',
        hubSubdomain: null,
        tunnelId: 'tunnel-123',
        tunnelToken: 'token-123',
      } as any);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('returns false when registration has no tunnel token', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-123',
        tunnelToken: null,
      } as any);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(false);
    });

    it('sets up infrastructure when local registration record is complete', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-123',
        name: 'Test Org',
        slug: 'test-org',
        hubSubdomain: 'hub-test-org',
        tunnelId: 'tunnel-123',
        tunnelToken: 'token-123',
      } as any);
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'test-api-key',
        domain: 'example.com',
        userSettings: { domain: 'example.com' },
      } as any);

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await (service as any).checkRegistrationWithCloud();

      expect(result).toBe(true);
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
        ciCloudUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
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
          provisioningPhase: 'locally_ready',
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

    it('transitions to locally_ready after successful infrastructure setup', async () => {
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 't1', token: 'tok1' } as any);
      configService.setDomain.mockResolvedValue(undefined);
      global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;

      // Start from paired phase
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-new' } as any);
      await service.setPhase('paired');

      await (service as any).setupOrganizationInfrastructure('org-new', {
        organization_name: 'New Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'device1-neworg',
        slug: 'neworg',
        domain: 'example.com',
      });

      // Should have reached locally_ready or publicly_ready
      const status = service.getRegistrationStatus();
      expect(['locally_ready', 'publicly_ready']).toContain(status.phase);
      expect(status.registered).toBe(true);
    });
  });

  describe('pairDevice', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      // Device is not yet registered
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
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

      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: portalResponse,
      } as any);

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);
      configService.setDomain.mockResolvedValue(undefined);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(true);
      expect(result.domain).toBe('companionintelligence.com');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/pair',
        { pairing_code: 'ABC123', device_id: 'test-device' },
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        }),
      );
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
      mockedAxios.post.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
        data: { error: 'Invalid pairing code' },
      } as any);

      const result = await service.pairDevice('XXXXXX');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid pairing code');
    });

    it('returns error when device is already registered', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'locally_ready',
        degradedReasons: '[]',
      } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Device is already registered.');
    });

    it('returns error when Portal is unreachable', async () => {
      mockedAxios.post.mockRejectedValue(new TypeError('fetch failed'));

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unable to reach CI Portal');
    });

    it('returns error when CI Cloud URL is not configured', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudUrl: '',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('CI Cloud URL not configured.');
    });

    it('returns error when Portal returns incomplete data', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-pair',
          // missing tunnel_id, tunnel_token, subdomain, slug
        },
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Portal returned incomplete registration data.');
    });
  });

  describe('completeRegistrationFromCallback', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'myhost.example.com',
      } as any);
      (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'test-device' });
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
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

    it('transitions to paired phase on callback', async () => {
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      await service.completeRegistrationFromCallback({
        deviceId: 'test-device',
        organizationId: 'org-cb',
        organizationName: 'Callback Org',
        slug: 'cb-org',
        subdomain: 'hub-cb-org',
        tunnelId: 'tunnel-cb',
        tunnelToken: 'token-cb',
        apiKey: 'key-cb',
      });

      // After callback, phase should be paired (infra setup is fire-and-forget)
      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('paired');
      setupSpy.mockRestore();
    });

    it('uses domain from callback data when provided (fixes #190)', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
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
        ciCloudUrl: 'http://cloud.api',
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

  describe('syncPhaseFromDb — bootstrap degradation', () => {
    it('transitions a persisted operational phase to degraded when tunnel token is missing', async () => {
      // Simulate a DB row whose provisioningPhase is 'locally_ready' but
      // the tunnel token file is absent on disk (container restart / volume loss).
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'locally_ready',
        degradedReasons: '[]',
      } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);

      await (service as any).syncPhaseFromDb();

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('degraded');
      expect(status.degradedReasons).toContain('tunnel_token_missing');
    });

    it('keeps persisted phase when tunnel token is present', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'publicly_ready',
        degradedReasons: '[]',
      } as any);

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);

      await (service as any).syncPhaseFromDb();

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('publicly_ready');
      expect(status.degradedReasons).toEqual([]);
    });
  });

  describe('validateRegistrationWithCloud — degraded state', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'test-api-key',
        userSettings: { domain: 'example.com' },
      } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
    });

    it('transitions to degraded when tunnel token is missing', async () => {
      // Manually set phase to locally_ready
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);

      await (service as any).validateRegistrationWithCloud();

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('degraded');
      expect(status.degradedReasons).toContain('tunnel_token_missing');
    });

    it('transitions to degraded after 3 consecutive CI Cloud errors', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 500 } as any);

      // First two calls should NOT transition to degraded
      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');

      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');

      // Third call should trigger degraded
      await (service as any).validateRegistrationWithCloud();

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('degraded');
      expect(status.degradedReasons).toContain('cloud_validation_failed');
    });

    it('clears local registration immediately on 400 (device removed from Portal)', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);
      mockedAxios.post.mockResolvedValue({ status: 400 } as any);

      try {
        await (service as any).validateRegistrationWithCloud();

        const status = service.getRegistrationStatus();
        expect(status.phase).toBe('unregistered');
        expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalled();
      } finally {
        service.onApplicationShutdown();
      }
    });

    it('counts network/timeout errors toward the failure threshold', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');

      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');

      // Third failure (network error) should trigger degraded
      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('degraded');
    });

    it('recovers from degraded when validation passes', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['cloud_validation_failed']);

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'active' } } as any);
      mockedAxios.head.mockResolvedValue({ status: 200 } as any);

      await (service as any).validateRegistrationWithCloud();

      const status = service.getRegistrationStatus();
      expect(status.phase).toBe('locally_ready');
      expect(status.degradedReasons).toEqual([]);
    });
  });
});
