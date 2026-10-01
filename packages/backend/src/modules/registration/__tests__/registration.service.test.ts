import { Test, TestingModule } from '@nestjs/testing';
import { PORTAL_REJECTION_CONFIRM_MS, PUBLIC_UNREACHABLE_CONFIRM_MS, RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TunnelHealthService } from '../../cloudflare/tunnel-health.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import axios from 'axios';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { TailscaleService } from '../../tailscale/tailscale.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as si from 'systeminformation';
import path from 'node:path';
import { vol } from 'memfs';
import { TUNNEL_DIR } from '@/common/constants';
import { writePairingAppCheck } from '../../app-lifecycle/registration-recovery-state';
import { probePublicHostname } from '../public-reachability';

vi.mock('systeminformation');
vi.mock('axios');
vi.mock('../../app-lifecycle/registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-lifecycle/registration-recovery-state')>()),
  writePairingAppCheck: vi.fn(),
}));
// The public-URL probe opens sockets and asks real nameservers; no unit test here may reach the network.
vi.mock('../public-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-reachability')>()),
  probePublicHostname: vi.fn(),
}));

/** Runs `fn` as a check-in `ms` from now sees it: `Date.now()` moved on, and put back afterwards. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ms);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

const TOKEN_PATH = path.join(TUNNEL_DIR, 'token');
const REGISTRATION_MARKER_PATH = path.join(TUNNEL_DIR, 'registration.json');
const LEFTOVER_MARKER_PATH = path.join(TUNNEL_DIR, 'leftover.json');

function cloudflaredToken(tunnelId: string): string {
  return Buffer.from(JSON.stringify({ a: 'account-tag', t: tunnelId, s: 'tunnel-secret' })).toString('base64');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(vol.readFileSync(filePath, 'utf-8') as string);
}

describe('RegistrationService', () => {
  let service: RegistrationService;
  let configService: MockProxy<ConfigurationService>;
  let loggerService: MockProxy<LoggerService>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;
  let traefikConfigService: MockProxy<TraefikConfigService>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let repoEventsQueue: MockProxy<RepoEventsQueue>;
  let portalClient: MockProxy<PortalClientService>;
  let tailscaleService: MockProxy<TailscaleService>;
  let tunnelHealthService: MockProxy<TunnelHealthService>;
  const mockedAxios = vi.mocked(axios);
  const mockedProbe = vi.mocked(probePublicHostname);

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    loggerService = mock<LoggerService>();
    cloudflareClientService = mock<CloudflareClientService>();
    traefikConfigService = mock<TraefikConfigService>();
    traefikConfigService.writeHubRoute.mockResolvedValue(undefined);
    deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
    repoEventsQueue = mock<RepoEventsQueue>();
    portalClient = mock<PortalClientService>();
    tailscaleService = mock<TailscaleService>();
    tunnelHealthService = mock<TunnelHealthService>();
    // Default to the reading a Hub that has not probed yet would give, so any test that does not
    // care about the tunnel exercises the omit-`unknown` path rather than a convenient fiction.
    tunnelHealthService.getHealth.mockReturnValue('unknown');
    mockedAxios.post.mockReset();
    mockedAxios.head.mockReset();
    mockedProbe.mockReset();
    mockedProbe.mockResolvedValue({ reachable: false, via: 'system', detail: 'unit tests do not reach the network' });

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
        { provide: PortalClientService, useValue: portalClient },
        { provide: TailscaleService, useValue: tailscaleService },
        { provide: TunnelHealthService, useValue: tunnelHealthService },
      ],
    }).compile();

    service = module.get<RegistrationService>(RegistrationService);
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('callback nonce', () => {
    it('reuses the nonce in flight, so the registration page polling device-id does not replace it', () => {
      // The page re-reads `GET /registration/device-id` every few seconds while
      // unregistered; a fresh nonce per call would invalidate the one the person
      // is carrying through Portal.
      const first = service.mintCallbackNonce();

      expect(service.mintCallbackNonce()).toBe(first);
      expect(service.consumeCallbackNonce(first)).toBe(true);
    });

    it('spends the nonce once, and refuses a replay or an unknown value', () => {
      const nonce = service.mintCallbackNonce();

      expect(service.consumeCallbackNonce(nonce)).toBe(true);
      expect(service.consumeCallbackNonce(nonce)).toBe(false);
      expect(service.consumeCallbackNonce('not-a-nonce')).toBe(false);
      expect(service.consumeCallbackNonce(undefined)).toBe(false);
    });

    it('refuses a nonce that has aged past its TTL', () => {
      vi.useFakeTimers();

      try {
        const nonce = service.mintCallbackNonce();

        vi.advanceTimersByTime(30 * 60 * 1000 + 1);

        expect(service.consumeCallbackNonce(nonce)).toBe(false);
        expect(service.mintCallbackNonce()).not.toBe(nonce);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('isRegisteredAndServing', () => {
    /*
     * Narrower than `isRegistered` on purpose: a Hub that lost its tunnel token
     * is registered, but pairing again is how it recovers, and CI-OS's headless
     * setup service completes that pairing through the registration callback.
     */
    const setPhase = (phase: string, reasons: string[] = []) => {
      (service as any)._currentPhase = phase;
      (service as any)._degradedReasons = reasons;
      vi.spyOn(service as any, 'refreshPhaseFromSources').mockResolvedValue(undefined);
    };

    it('is true for a Hub that is up and serving', async () => {
      setPhase('publicly_ready');
      await expect(service.isRegisteredAndServing()).resolves.toBe(true);

      setPhase('locally_ready');
      await expect(service.isRegisteredAndServing()).resolves.toBe(true);
    });

    it('is false while a registered Hub is re-pairing to restore its tunnel', async () => {
      setPhase('degraded', ['tunnel_token_missing']);

      await expect(service.isRegisteredAndServing()).resolves.toBe(false);
      // Still registered — only the callback guard treats it differently.
      await expect(service.isRegistered()).resolves.toBe(true);
    });

    it('is false for a Hub whose device key Portal rejects, so the callback can re-pair it', async () => {
      setPhase('degraded', ['portal_rejected']);

      await expect(service.isRegisteredAndServing()).resolves.toBe(false);
    });

    it('is true for a Hub degraded for any other reason', async () => {
      setPhase('degraded', ['tunnel_unreachable']);

      await expect(service.isRegisteredAndServing()).resolves.toBe(true);
    });

    it('is false for an unregistered Hub', async () => {
      setPhase('unregistered');

      await expect(service.isRegisteredAndServing()).resolves.toBe(false);
    });
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

  describe('getRegistrationPhaseReport', () => {
    it('reports the phase without sending a check-in, where every status read past the throttle sends one', async () => {
      // Fleet preflight polled `GET /registration/status` on 16 Hubs and wrote Portal's `last_seen`
      // on every registered one. Observation must not change what it observes.
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', ciHubApiKey: 'k' } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockClear();
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockClear();
      const validate = vi.spyOn(service as any, 'validateRegistrationWithCloud').mockResolvedValue(undefined);

      const report = service.getRegistrationPhaseReport();

      expect(report).toEqual({
        phase: 'locally_ready',
        degradedReasons: [],
        registered: true,
        lastCheckIn: null,
        consecutiveCheckInFailures: 0,
      });
      expect(validate).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(deviceRegistrationRepository.getFirstDeviceRegistration).not.toHaveBeenCalled();
      expect(deviceRegistrationRepository.hasAnyDeviceRegistration).not.toHaveBeenCalled();

      // The contrast: the live status read does send one.
      await service.getLiveRegistrationStatus();
      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('returns a copy, so a caller cannot edit what the next reader sees', () => {
      (service as any).lastCheckIn = { at: '2026-09-17T09:15:00.000Z', httpStatus: 401, code: 'UNAUTHORIZED', error: 'HTTP 401: Invalid Device Key' };

      const report = service.getRegistrationPhaseReport();
      (report.lastCheckIn as { httpStatus: number }).httpStatus = 200;

      expect(service.getRegistrationPhaseReport().lastCheckIn?.httpStatus).toBe(401);
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
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });

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
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });

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

    describe('the registration probe', () => {
      const activation = {
        organization_name: 'New Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'hub-core-2-demopool1',
        slug: 'demopool1',
        domain: 'ci.computer',
      };

      beforeEach(async () => {
        deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-new' } as any);
        cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 't1', token: 'tok1' } as any);
        configService.setDomain.mockResolvedValue(undefined);
        await service.setPhase('paired');
      });

      it("promotes on the shared probe's 2xx, asked with the registration's per-step budget", async () => {
        // Which resolver the probe went through is its own business, tested with the production
        // wiring in public-reachability.test.ts; here it only has to be the probe, with 2 s steps.
        mockedProbe.mockResolvedValue({ reachable: true, via: 'zone_nameservers', status: 200 });

        await (service as any).setupOrganizationInfrastructure('org-new', activation);

        expect(mockedProbe).toHaveBeenCalledWith('hub-core-2-demopool1.ci.computer', { timeoutMs: 2_000 });
        expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
      });

      it('does not promote a Hub that turned degraded while the probe ran, which would erase the reason', async () => {
        // `degraded` → `publicly_ready` is legal, so only this guard keeps three failed check-ins
        // during the minute-long loop from being overwritten by its late success.
        mockedProbe.mockImplementation(async () => {
          await service.setPhase('degraded', ['cloud_validation_failed']);
          return { reachable: true, via: 'system', status: 200 };
        });

        await (service as any).setupOrganizationInfrastructure('org-new', activation);

        expect(service.getRegistrationStatus()).toEqual({ phase: 'degraded', degradedReasons: ['cloud_validation_failed'], registered: true });
      });

      it('does not promote for a registration the Hub replaced while the probe ran', async () => {
        mockedProbe.mockImplementation(async () => {
          (service as any).registrationGeneration++;
          return { reachable: true, via: 'system', status: 200 };
        });

        await (service as any).setupOrganizationInfrastructure('org-new', activation);

        expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      });

      it('gives up after a minute of wall-clock time, however long each attempt takes', async () => {
        // An attempt that goes around a cached NXDOMAIN to a hung origin takes three 2 s steps, and
        // `register` waits for this loop: sixty of those were six minutes, not one.
        vi.useFakeTimers();
        try {
          mockedProbe.mockImplementation(async () => {
            vi.setSystemTime(Date.now() + 6_000);
            return { reachable: false, via: 'zone_nameservers', detail: 'no response within 2000 ms' };
          });

          let finished = false;
          const setup = (service as any).setupOrganizationInfrastructure('org-new', activation).then(() => (finished = true));
          for (let tick = 0; tick < 120 && !finished; tick++) {
            await vi.advanceTimersByTimeAsync(1_000);
          }
          await setup;

          expect(mockedProbe.mock.calls.length).toBeLessThanOrEqual(10);
          expect(service.getRegistrationStatus().phase).toBe('locally_ready');
          expect(loggerService.warn).toHaveBeenCalledWith(
            expect.stringContaining('Tunnel not yet reachable at https://hub-core-2-demopool1.ci.computer after 60s'),
          );
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('clears portal_rejected when a re-pair into the same organization lands, instead of waiting for the next check-in', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-existing' } as any);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['portal_rejected']);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue({
        id: 'org-existing',
        slug: 'existing',
        name: 'Existing Org',
        tunnelId: 't-old',
        tunnelToken: 'tok-old',
        hubSubdomain: 'hub-existing',
      } as any);

      await (service as any).setupOrganizationInfrastructure('org-existing', {
        organization_name: 'Existing Org',
        tunnel_id: 't-new',
        tunnel_token: 'tok-new',
        subdomain: 'hub-existing',
        slug: 'existing',
      });

      expect(service.getRegistrationStatus()).toEqual({ phase: 'locally_ready', degradedReasons: [], registered: true });
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('probes the public URL after a re-pair into the same organization, which skips the registration loop', async () => {
      // Without this, nothing probed until the next accepted check-in, up to 15 minutes later.
      const row = {
        id: 'org-existing',
        slug: 'existing',
        name: 'Existing Org',
        tunnelId: 't-old',
        tunnelToken: 'tok-old',
        hubSubdomain: 'hub-core-2-demopool1',
      } as any;
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', domain: 'ci.computer' } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(row);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(row);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['portal_rejected']);
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });

      await (service as any).setupOrganizationInfrastructure('org-existing', {
        organization_name: 'Existing Org',
        tunnel_id: 't-new',
        tunnel_token: 'tok-new',
        subdomain: 'hub-core-2-demopool1',
        slug: 'existing',
      });

      await vi.waitFor(() => expect(service.getRegistrationStatus().phase).toBe('publicly_ready'));
      expect(mockedProbe).toHaveBeenCalledWith('hub-core-2-demopool1.ci.computer');
    });

    it("replaces the previous organization's row on a re-pair into another, so boot recovery cannot restore the old tunnel token", async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-old' } as any);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['portal_rejected']);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 't1', token: 'tok1' } as any);
      configService.setDomain.mockResolvedValue(undefined);
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });

      await (service as any).setupOrganizationInfrastructure('org-new', {
        organization_name: 'New Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'device1-neworg',
        slug: 'neworg',
        domain: 'example.com',
      });

      expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalledTimes(1);
      expect(deviceRegistrationRepository.deleteAll.mock.invocationCallOrder[0]).toBeLessThan(
        deviceRegistrationRepository.createDeviceRegistration.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('leaves existing rows alone when the Hub was not re-pairing, so an unauthenticated register call cannot delete a serving registration', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-old' } as any);
      await service.setPhase('locally_ready');
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 't1', token: 'tok1' } as any);
      configService.setDomain.mockResolvedValue(undefined);
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });

      await (service as any).setupOrganizationInfrastructure('org-new', {
        organization_name: 'New Org',
        tunnel_id: 't1',
        tunnel_token: 'tok1',
        subdomain: 'device1-neworg',
        slug: 'neworg',
        domain: 'example.com',
      });

      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
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
      // No `ciHubApiKey` in this config: a first pair sends no device key. The deadline rides on
      // the test that also proves the pair succeeded, so trimming it cannot leave a green
      // assertion over a broken pairing path.
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/pair',
        { pairing_code: 'ABC123', device_id: 'test-device' },
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
          timeout: 60_000,
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

    it('sends the stored device credential as proof of possession when the Hub has one', async () => {
      // `resetRegistration` leaves `ciHubApiKey` in settings.json, so a reset Hub
      // still holds the proof the Portal now demands to re-key it (CI-Portal#688).
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'stored-device-key',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-pair',
          organization_name: 'Paired Org',
          slug: 'paired-org',
          subdomain: 'hub-paired-org',
          tunnel_id: 'tunnel-pair',
          tunnel_token: 'token-pair',
          api_key: 'key-pair',
          domain: 'companionintelligence.com',
        },
      } as any);

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);
      configService.setDomain.mockResolvedValue(undefined);

      await service.pairDevice('ABC123');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/pair',
        { pairing_code: 'ABC123', device_id: 'test-device', device_key: 'stored-device-key' },
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );

      setupSpy.mockRestore();
    });

    it('sends the stored move key with the device key, and keeps the new one a pairing returns', async () => {
      // The move key is what lets this Hub move itself out of another organization. It rides with the
      // device key on every pair, because the Portal checks proof before it asks to confirm a move.
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'stored-device-key',
        ciHubMoveKey: 'stored-move-key',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-pair',
          organization_name: 'Paired Org',
          slug: 'paired-org',
          subdomain: 'hub-paired-org',
          tunnel_id: 'tunnel-pair',
          tunnel_token: 'token-pair',
          api_key: 'key-pair',
          move_key: 'move-pair',
          domain: 'companionintelligence.com',
        },
      } as any);

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);
      configService.setDomain.mockResolvedValue(undefined);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/pair',
        { pairing_code: 'ABC123', device_id: 'test-device', device_key: 'stored-device-key', move_key: 'stored-move-key' },
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'key-pair' });
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubMoveKey: 'move-pair' });

      setupSpy.mockRestore();
    });

    it('keeps the stored move key when a Portal older than move keys returns none', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'stored-device-key',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-pair',
          organization_name: 'Paired Org',
          slug: 'paired-org',
          subdomain: 'hub-paired-org',
          tunnel_id: 'tunnel-pair',
          tunnel_token: 'token-pair',
          api_key: 'key-pair',
          domain: 'companionintelligence.com',
        },
      } as any);

      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);
      configService.setDomain.mockResolvedValue(undefined);

      await service.pairDevice('ABC123');

      expect(mockedAxios.post.mock.calls[0]?.[1]).not.toHaveProperty('move_key');
      expect(configService.setUserSettings).not.toHaveBeenCalledWith(expect.objectContaining({ ciHubMoveKey: expect.anything() }));

      setupSpy.mockRestore();
    });

    it('omits device_key rather than sending an empty one when no credential is stored', async () => {
      // An empty string is not a credential, and sending one would have the
      // Portal look up a device by `''` instead of treating the caller as
      // key-less.
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: '',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);

      mockedAxios.post.mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
        data: { error: 'Invalid pairing code' },
      } as any);

      await service.pairDevice('ABC123');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/pair',
        { pairing_code: 'ABC123', device_id: 'test-device' },
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
    });

    it('refuses cleanly when the Portal answers 200 with no body', async () => {
      // `null` body: reading `.success` off it directly threw, turning a clean
      // refusal into "Pairing failed: Cannot read properties of null".
      mockedAxios.post.mockResolvedValue({ status: 200, data: null } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Portal returned incomplete registration data.');
    });

    it('passes the Portal refusal code on with its message', async () => {
      // The registration page picks its guidance by this code: a refused re-pair
      // opens "Reconnect this Hub" instead of showing the Portal's raw text.
      mockedAxios.post.mockResolvedValue({
        status: 403,
        statusText: 'Forbidden',
        data: {
          error: 'That device is already paired. Send its current device key to re-pair it, or ask an owner or admin to re-register it first.',
          code: 'DEVICE_PROOF_REQUIRED',
        },
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result).toEqual({
        success: false,
        message: 'That device is already paired. Send its current device key to re-pair it, or ask an owner or admin to re-register it first.',
        code: 'DEVICE_PROOF_REQUIRED',
      });
    });

    it('asks the Portal to move the Hub only once the person has confirmed it', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 409,
        data: {
          error: 'This Hub is registered to another organization.',
          code: 'DEVICE_MOVE_CONFIRMATION_REQUIRED',
          organization_name: 'Studio',
        },
      } as any);

      // First try: no confirmation sent, and the page is told which organization the move is into.
      const asked = await service.pairDevice('ABC123');

      expect(mockedAxios.post.mock.calls[0]?.[1]).not.toHaveProperty('confirm_move');
      expect(asked).toEqual({
        success: false,
        message: 'This Hub is registered to another organization.',
        code: 'DEVICE_MOVE_CONFIRMATION_REQUIRED',
        organizationName: 'Studio',
      });

      // After the yes, the same code is sent again with the confirmation.
      await service.pairDevice('ABC123', { confirmMove: true });

      expect(mockedAxios.post.mock.calls[1]?.[1]).toMatchObject({ pairing_code: 'ABC123', confirm_move: true });
    });

    it('passes the code on from a 200 answer that reports failure', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: false, error: 'This code was made for another device.', code: 'PAIRING_CODE_WRONG_DEVICE' },
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result).toEqual({ success: false, message: 'This code was made for another device.', code: 'PAIRING_CODE_WRONG_DEVICE' });
    });

    it('reports no code when the refusal carries none or a non-string one', async () => {
      // Older Portals and proxies in front of the Portal answer without a code; the page falls back to the message.
      mockedAxios.post.mockResolvedValueOnce({ status: 409, data: { error: 'Already registered elsewhere' } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 409, data: { error: 'Already registered elsewhere', code: 42 } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 502, data: '<html>Bad gateway</html>' } as any);

      const withoutCode = await service.pairDevice('ABC123');
      const numericCode = await service.pairDevice('ABC123');
      const htmlBody = await service.pairDevice('ABC123');

      expect(withoutCode).not.toHaveProperty('code');
      expect(numericCode).not.toHaveProperty('code');
      expect(htmlBody).toEqual({ success: false, message: 'Pairing failed: HTTP 502' });
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

    it('surfaces Portal 429 wait copy instead of a generic pairing failure', async () => {
      mockedAxios.post.mockResolvedValue({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '8' },
        data: { error: 'Rate limited' },
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Too many attempts. Try again in 8 seconds.');
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

    it('lets a Hub whose device key Portal rejects pair again without resetting, since no retry can revive the key', async () => {
      // Five fleet Hubs sat here for up to a week: registered locally, key dead at Portal, and
      // `pairDevice` refusing them as "already registered", so the only way back was a reset that
      // deletes the tunnel token.
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'degraded',
        degradedReasons: '["portal_rejected"]',
      } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      (service as any)._currentPhase = 'degraded';
      (service as any)._degradedReasons = ['portal_rejected'];
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-1',
          organization_name: 'Org',
          slug: 'org',
          subdomain: 'hub-org',
          tunnel_id: 'tunnel-1',
          tunnel_token: 'token-1',
          api_key: 'fresh-key',
          domain: 'companionintelligence.com',
        },
      } as any);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.pairDevice('ABC123', { callerAuthenticated: true });

      expect(result.success).toBe(true);
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'fresh-key' });
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      setupSpy.mockRestore();
    });

    it('refuses to re-pair a registered Hub for a caller nobody authenticated, who could move it into their own organization', async () => {
      // The route is unauthenticated for first pairing, and this Hub sends its own device key as proof
      // of possession, so Portal would accept a code from any organization the caller belongs to.
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'degraded',
        degradedReasons: '["portal_rejected"]',
      } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      (service as any)._currentPhase = 'degraded';
      (service as any)._degradedReasons = ['portal_rejected'];

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('cihub register --code');
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(configService.setUserSettings).not.toHaveBeenCalled();
    });

    it('lets an authenticated caller re-pair while Portal is still rejecting the key, before the rejection is confirmed', async () => {
      // The documented remedy is "update, then `cihub register --code`". The update restarts the Hub,
      // which restarts the ten-minute confirmation, so without this the remedy is refused on arrival.
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        provisioningPhase: 'degraded',
        degradedReasons: '["cloud_validation_failed"]',
      } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      (service as any)._currentPhase = 'degraded';
      (service as any)._degradedReasons = ['cloud_validation_failed'];
      mockedAxios.post.mockResolvedValueOnce({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().degradedReasons).toEqual(['cloud_validation_failed']);

      // Not for a stranger, and not for anyone while Portal accepts the key.
      await expect(service.pairDevice('ABC123')).resolves.toMatchObject({ success: false, message: 'Device is already registered.' });

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-1',
          organization_name: 'Org',
          slug: 'org',
          subdomain: 'hub-org',
          tunnel_id: 'tunnel-1',
          tunnel_token: 'token-1',
          api_key: 'fresh-key',
          domain: 'companionintelligence.com',
        },
      } as any);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.pairDevice('ABC123', { callerAuthenticated: true });

      expect(result.success).toBe(true);
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'fresh-key' });
      setupSpy.mockRestore();
    });

    it('refuses an authenticated re-pair of a Hub Portal accepts, which is what reset is for', async () => {
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1', provisioningPhase: 'publicly_ready' } as any);
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      (service as any)._currentPhase = 'publicly_ready';

      await expect(service.pairDevice('ABC123', { callerAuthenticated: true })).resolves.toMatchObject({
        success: false,
        message: 'Device is already registered.',
      });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('returns error when Portal is unreachable', async () => {
      // Shaped like a real axios transport failure: `validateStatus` accepts every
      // status, so a thrown error here never carries a `response`.
      mockedAxios.post.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { isAxiosError: true, code: 'ECONNREFUSED' }));

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unable to reach CI Portal');
    });

    // Shapes measured against the axios 1.18 this package resolves, not invented:
    // a failed connection attempt keeps Node's `syscall` on `cause`, while axios's
    // own expired deadline is a bare `AxiosError` with no `cause` at all.
    it.each([
      // Our own deadline. Identical whether the SYN went unanswered or the Portal
      // is still provisioning, so the copy must not assert either one.
      ['our expired deadline', Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' })],
      // The same deadline once axios's `transitional.clarifyTimeoutError` default flips.
      ['a clarified deadline', Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ETIMEDOUT' })],
      // The request went out in full and the peer hung up afterwards, so the Portal
      // may already hold it — the network copy would be just as wrong here.
      [
        'a socket hang up after the request was sent',
        Object.assign(new Error('socket hang up'), { isAxiosError: true, code: 'ECONNRESET', cause: { code: 'ECONNRESET' } }),
      ],
      // A syscall that is not `connect`/`getaddrinfo` means we were already past
      // the connection and writing to the Portal, so it may hold a partial request.
      [
        'a write that failed mid-request',
        Object.assign(new Error('write EPIPE'), { isAxiosError: true, code: 'EPIPE', cause: { code: 'EPIPE', syscall: 'write' } }),
      ],
    ])('says the Portal may hold the request when pairing fails on %s', async (_label, error) => {
      mockedAxios.post.mockRejectedValue(error);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('did not answer in time');
      // Both halves of the ambiguity, and the action. Asserting only the first
      // let a copy edit drop either of the others with the suite still green.
      expect(result.message).toContain('still be provisioning');
      expect(result.message).toContain('may not be reaching it');
      expect(result.message).toContain('new pairing code');
      expect(result.message).not.toContain('Unable to reach CI Portal');
    });

    it.each([
      // `connect ETIMEDOUT` is a firewall dropping our SYN, NOT our own deadline:
      // the Portal never saw the request and the pairing code is still good.
      ['connect ETIMEDOUT 10.255.255.1:443', 'ETIMEDOUT', 'connect'],
      ['getaddrinfo ENOTFOUND portal.example.com', 'ENOTFOUND', 'getaddrinfo'],
    ])('reports %s as a Portal it could not reach', async (message, code, syscall) => {
      mockedAxios.post.mockRejectedValue(Object.assign(new Error(message), { isAxiosError: true, code, cause: { code, syscall } }));

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unable to reach CI Portal');
      expect(result.message).not.toContain('new pairing code');
    });

    it('leaves a failure that is not an axios error on the generic branch', async () => {
      // Pins the `isAxiosError` guard: without it a local bug thrown inside the try
      // would be reported as the Portal holding the request, burning a pairing code.
      mockedAxios.post.mockRejectedValue(new Error('boom'));

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Pairing failed: boom');
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

  describe('pairing under a DEVICE_ID copied from another machine', () => {
    // beta-red and beta-nas, 2026-09-17: one DEVICE_ID in both env files, and neither host's machine ID. Placeholder value.
    const COPIED = 'c0ffee00c0ffee00c0ffee00c0ffee00';
    const foreign = { status: 'foreign' as const, deviceId: COPIED, message: `DEVICE_ID=${COPIED} was not generated on this machine` };

    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue(COPIED);
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
    });

    it('refuses a pairing code before Portal can bind the other Hub’s device', async () => {
      vi.spyOn(service, 'getDeviceIdHostBinding').mockReturnValue(foreign);

      const result = await service.pairDevice('ABC123');

      expect(result).toEqual({ success: false, message: foreign.message });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('refuses the manual registration form under the environment’s DEVICE_ID', async () => {
      vi.spyOn(service, 'getDeviceIdHostBinding').mockReturnValue(foreign);

      const result = await service.initiateRegistration('org-1', 'My Org');

      expect(result).toEqual({ success: false, message: foreign.message });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('leaves an ID the operator typed into the form to the operator', async () => {
      vi.spyOn(service, 'getDeviceIdHostBinding').mockReturnValue(foreign);
      mockedAxios.post.mockResolvedValue({ status: 500, data: {} } as any);

      await service.initiateRegistration('org-1', 'My Org', 'typed-by-the-operator');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://cloud.api/api/devices/register',
        expect.objectContaining({ device_id: 'typed-by-the-operator' }),
        expect.anything(),
      );
    });

    it.each([
      [{ status: 'matches_host' as const, deviceId: COPIED }],
      [{ status: 'allowed_foreign' as const, deviceId: COPIED }],
      [{ status: 'not_set' as const }],
      [{ status: 'not_checkable' as const, deviceId: COPIED, reason: 'no machine id' }],
    ])('does not refuse when the binding is %o', async (binding) => {
      vi.spyOn(service, 'getDeviceIdHostBinding').mockReturnValue(binding);
      mockedAxios.post.mockResolvedValue({ status: 400, data: { error: 'Invalid pairing code' } } as any);

      await service.pairDevice('ABC123');

      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  describe('probePortalDeviceActive', () => {
    const probe = () => (service as any).probePortalDeviceActive('test-device', 'http://cloud.api/') as Promise<boolean | null>;

    beforeEach(() => {
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', ciHubApiKey: 'stored-device-key' } as any);
    });

    it('asks nothing when the Hub holds no device key', async () => {
      // A keyless call can only be refused, and the Portal offers no keyless "does this device exist" lookup.
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', ciHubApiKey: '' } as any);

      await expect(probe()).resolves.toBeNull();

      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api' } as any);

      await expect(probe()).resolves.toBeNull();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('asks device WhoIs with the key, never check-in, so probing does not mark the device as seen', async () => {
      mockedAxios.post.mockResolvedValue({ status: 403, data: { error: 'Not a member', code: 'GRANT_DENIED' } } as any);

      await expect(probe()).resolves.toBe(true);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body, options] = mockedAxios.post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
      expect(url).toBe('http://cloud.api/api/whois');
      expect(url).not.toContain('check-in');
      expect(body).toEqual({ subject: 'ci-hub-device-key-probe', appIds: [], surface: 'hub' });
      expect(options.headers).toMatchObject({ 'x-device-key': 'stored-device-key' });
    });

    it('counts every answer that got past device authentication as an active device', async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { organizations: [] } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 409, data: { error: 'Name the organization', code: 'ORGANIZATION_REQUIRED' } } as any);

      await expect(probe()).resolves.toBe(true);
      await expect(probe()).resolves.toBe(true);
    });

    it('does not know when the key is refused, the refusal is not from WhoIs, or the Portal is unreachable', async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 403, data: '<html>Blocked</html>' } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: '<html>Sign in to this network</html>' } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { success: true } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 400, data: { success: false } } as any);
      mockedAxios.post.mockResolvedValueOnce({ status: 503, data: { error: 'WhoIs unavailable', code: 'UNAVAILABLE' } } as any);
      mockedAxios.post.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true }));

      for (let i = 0; i < 7; i++) {
        await expect(probe()).resolves.toBeNull();
      }
    });
  });

  describe('initiateRegistration', () => {
    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', userSettings: {}, domain: 'example.com' } as any);
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
    });

    it('holds app sync for the apps check once the Portal has registered the device', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: { tunnel_id: 't', tunnel_token: 'tok', subdomain: 'hub-org' } } as any);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      const result = await service.initiateRegistration('org-id', 'Org');

      expect(result.success).toBe(true);
      expect(writePairingAppCheck).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writePairingAppCheck).mock.invocationCallOrder[0]).toBeLessThan(setupSpy.mock.invocationCallOrder[0] ?? 0);
      setupSpy.mockRestore();
    });

    it('does not hold app sync when the Portal refuses the registration', async () => {
      mockedAxios.post.mockResolvedValue({ status: 403, statusText: 'Forbidden', data: { error: 'nope' } } as any);

      const result = await service.initiateRegistration('org-id', 'Org');

      expect(result.success).toBe(false);
      expect(writePairingAppCheck).not.toHaveBeenCalled();
    });

    it('logs the Portal answer without its tunnel token', async () => {
      // Logged at info, the default level, and whoever holds the token can run a connector for this
      // Hub's tunnel.
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { tunnel_id: 'tunnel-1', tunnel_token: 'leaked-tunnel-token', subdomain: 'hub-org' },
      } as any);
      const setupSpy = vi.spyOn(service as any, 'setupOrganizationInfrastructure').mockResolvedValue(undefined);

      await service.initiateRegistration('org-id', 'Org');

      const everyCall = JSON.stringify(
        [loggerService.debug, loggerService.info, loggerService.warn, loggerService.error].map((level) => level.mock.calls),
      );
      expect(everyCall).not.toContain('leaked-tunnel-token');
      expect(loggerService.info).toHaveBeenCalledWith(
        'Device registered successfully: {"tunnel_id":"tunnel-1","tunnel_token":"[redacted]","subdomain":"hub-org"}',
      );
      setupSpy.mockRestore();
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

    /*
     * Pairing back onto an existing device synced this Hub's current app list, empty after a reinstall,
     * and the Portal released every app the device had. The check that holds that sync must be in place
     * before anything of the new registration is.
     */
    it('holds app sync for the apps check before saving the new registration', async () => {
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

      expect(writePairingAppCheck).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writePairingAppCheck).mock.invocationCallOrder[0]).toBeLessThan(
        configService.setUserSettings.mock.invocationCallOrder[0] ?? 0,
      );
      expect(vi.mocked(writePairingAppCheck).mock.invocationCallOrder[0]).toBeLessThan(setupSpy.mock.invocationCallOrder[0] ?? 0);
      setupSpy.mockRestore();
    });

    it('does not hold app sync for a callback meant for another device', async () => {
      const result = await service.completeRegistrationFromCallback({
        deviceId: 'another-device',
        organizationId: 'org-cb',
        organizationName: 'Callback Org',
        slug: 'cb-org',
        subdomain: 'hub-cb-org',
        tunnelId: 'tunnel-cb',
        tunnelToken: 'token-cb',
        apiKey: 'key-cb',
      });

      expect(result.success).toBe(false);
      expect(writePairingAppCheck).not.toHaveBeenCalled();
    });

    it('completes the pairing even when the hold cannot be written, keeping the device key the Portal issued', async () => {
      vi.mocked(writePairingAppCheck).mockRejectedValueOnce(new Error('EACCES'));
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
      expect(configService.setUserSettings).toHaveBeenCalledWith({ ciHubApiKey: 'key-cb' });
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

    it('authenticates the check-in with the device API key (x-device-key)', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);

      await (service as any).validateRegistrationWithCloud();

      // The Portal check-in endpoint is device-authenticated; a registered device
      // must present its key or it would be wrongly marked degraded.
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/devices/check-in'),
        expect.objectContaining({ device_id: 'test-device' }),
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-device-key': 'test-api-key' }),
        }),
      );
    });

    it("piggybacks this node's current Tailscale name on the check-in, for Hub Pool's Portal discovery leg", async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      tailscaleService.getStatusCached.mockResolvedValue({
        installed: true,
        connected: true,
        nodeFqdn: 'my-hub.example-tailnet.ts.net',
      } as any);

      await (service as any).validateRegistrationWithCloud();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/devices/check-in'),
        expect.objectContaining({ device_id: 'test-device', tailscale_dns: 'my-hub.example-tailnet.ts.net' }),
        expect.anything(),
      );
    });

    it('omits tailscale_dns rather than sending a false "no tailnet" when the tailscale service has no answer right now', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      /*
       * No `installed`, deliberately: this is the "Tailscale gave us nothing
       * conclusive" case, and the payload must then omit BOTH the name and
       * `tailscale_connected` rather than assert a tailnet state it cannot see.
       */
      tailscaleService.getStatusCached.mockResolvedValue({ nodeFqdn: null } as any);

      await (service as any).validateRegistrationWithCloud();

      const body = mockedAxios.post.mock.calls[0]?.[1];
      expect(body).toEqual({ device_id: 'test-device', phase: 'locally_ready' });
      expect(body).not.toHaveProperty('tailscale_dns');
    });

    it('reports the provisioning phase on every check-in, so Portal can say why a device is unhealthy', async () => {
      // Portal knows when a Hub last checked in; only the Hub knows what state it was in when it
      // did. Without this field an org status report can say "seen 4 minutes ago" and nothing more.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
      await service.setPhase('publicly_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);

      await (service as any).validateRegistrationWithCloud();

      const body = mockedAxios.post.mock.calls[0]?.[1];
      expect(body).toMatchObject({ phase: 'publicly_ready' });
      expect(body).not.toHaveProperty('degraded_reasons');
    });

    it('reports the degraded reasons, which is the field that tells an owner what to actually do', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
      await service.setPhase('degraded', ['tunnel_unreachable']);

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);

      await (service as any).validateRegistrationWithCloud();

      const body = mockedAxios.post.mock.calls[0]?.[1];
      expect(body).toMatchObject({ phase: 'degraded', degraded_reasons: ['tunnel_unreachable'] });
    });

    it('reports a conclusive tunnel health and the Hub version', async () => {
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'test-api-key',
        version: '0.2.67',
        userSettings: { domain: 'example.com' },
      } as any);
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      tunnelHealthService.getHealth.mockReturnValue('down');
      /*
       * `installed: true` matters here and is not padding. `tailscale_connected`
       * is only reported for a node that actually HAS Tailscale — the service's
       * `notInstalled` literal hard-codes `connected: false`, so passing that
       * through would report a Hub without Tailscale as disconnected from a
       * tailnet it never had. A mock that omits `installed` is not a state the
       * real service can produce.
       */
      tailscaleService.getStatusCached.mockResolvedValue({
        installed: true,
        nodeFqdn: null,
        connected: true,
      } as any);

      await (service as any).validateRegistrationWithCloud();

      const body = mockedAxios.post.mock.calls[0]?.[1];
      expect(body).toMatchObject({ tunnel_health: 'down', hub_version: '0.2.67', tailscale_connected: true });
    });

    it('omits tunnel_health while the tunnel probe has no conclusive reading', async () => {
      // `unknown` is what a Hub that just booted reports, which is precisely when the first
      // check-in fires. Putting it on the wire would read at Portal as a real tunnel state.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      tunnelHealthService.getHealth.mockReturnValue('unknown');

      await (service as any).validateRegistrationWithCloud();

      expect(mockedAxios.post.mock.calls[0]?.[1]).not.toHaveProperty('tunnel_health');
    });

    it('still checks in, and does not count a failure, when a diagnostic source throws', async () => {
      // The check-in's real job is asking Portal whether this device is still active. A wedged
      // Tailscale daemon or a throwing tunnel probe is not Portal being unreachable, and must not
      // push this Hub toward `degraded` and a spurious "re-pair me" prompt.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      tailscaleService.getStatusCached.mockRejectedValue(new Error('tailscaled is not running'));
      tunnelHealthService.getHealth.mockImplementation(() => {
        throw new Error('probe exploded');
      });

      await (service as any).validateRegistrationWithCloud();

      const body = mockedAxios.post.mock.calls[0]?.[1];
      expect(body).toEqual({ device_id: 'test-device', phase: 'locally_ready' });
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
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

    it('reports portal_rejected once Portal has kept rejecting the key, where it used to say "wait" for a week', async () => {
      // Measured 2026-09-17: core-14, beta-1, beta-3-glass and liam-demo all got this 401 from
      // 05:45Z on 2026-09-16 and reported `cloud_validation_failed`, a reason that says "wait".
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
      await service.setPhase('publicly_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);

      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
      // Visible at once to anyone who looks, even before it is acted on.
      expect(service.getRegistrationPhaseReport().lastCheckIn).toMatchObject({
        httpStatus: 401,
        code: 'UNAUTHORIZED',
        error: 'HTTP 401: Invalid Device Key',
      });

      await later(PORTAL_REJECTION_CONFIRM_MS, () => (service as any).validateRegistrationWithCloud());

      expect(service.getRegistrationStatus()).toEqual({ phase: 'degraded', degradedReasons: ['portal_rejected'], registered: true });
    });

    it('clears local registration immediately on 400 DEVICE_NOT_ACTIVE (device removed from Portal)', async () => {
      // The one coded answer that is a removal, and the one the Settings removal watch waits for. It
      // is not held back by the confirmation window below: Portal names the device, not just the key.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);
      mockedAxios.post.mockResolvedValue({ status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } } as any);

      try {
        await expect((service as any).validateRegistrationWithCloud()).resolves.toBe('removed');

        const status = service.getRegistrationStatus();
        expect(status.phase).toBe('unregistered');
        expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalled();
      } finally {
        service.onApplicationShutdown();
      }
    });

    it('does not tell every Hub to pair again over a Portal database blip, which answers the same 401', async () => {
      // CI-Portal `deviceAuthMiddleware`: `!result.ok || !result.data` → 401 "Invalid Device Key", so a
      // D1 read error inside `findByApiKey` is indistinguishable from a removed device.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      // Status polling during the blip checks in every 30 s.
      await (service as any).validateRegistrationWithCloud();
      await later(30_000, () => (service as any).validateRegistrationWithCloud());
      await later(60_000, () => (service as any).validateRegistrationWithCloud());

      expect(service.getRegistrationStatus().degradedReasons).not.toContain('portal_rejected');

      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'OK' } } as any);
      mockedAxios.head.mockResolvedValue({ status: 200 } as any);
      await later(90_000, () => (service as any).validateRegistrationWithCloud());

      // The blip is forgotten: a 401 after it starts a new ten minutes rather than confirming the old one.
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      await later(PORTAL_REJECTION_CONFIRM_MS, () => (service as any).validateRegistrationWithCloud());

      expect(service.getRegistrationStatus()).toEqual({ phase: 'locally_ready', degradedReasons: [], registered: true });
    });

    it('keeps the registration and tunnel token when Portal refuses the key, so a Portal incident is not a public outage', async () => {
      // A refused key is not a removal. Portal answers 401 for a device it removed, for a key a later
      // pair rotated, and for a D1 read error alike, so the Hub degrades and goes on serving. Only the
      // coded DEVICE_NOT_ACTIVE above clears the registration.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      const resetSpy = vi.spyOn(service, 'resetRegistration');

      await (service as any).validateRegistrationWithCloud();
      await later(PORTAL_REJECTION_CONFIRM_MS, () => (service as any).validateRegistrationWithCloud());

      expect(service.getRegistrationStatus().degradedReasons).toEqual(['portal_rejected']);
      expect(resetSpy).not.toHaveBeenCalled();
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('never unpairs over a check-in body Portal refused, which is a schema mismatch and not a removal', async () => {
      // CI-Portal's CheckIn.ts: a vocabulary mismatch "makes every healthy Hub in the fleet unpair
      // itself, one per hourly check-in". It stays a transient failure.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 400, data: { success: false, error: { name: 'ZodError' } } } as any);

      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');

      await (service as any).validateRegistrationWithCloud();
      await (service as any).validateRegistrationWithCloud();

      expect(service.getRegistrationStatus()).toEqual({ phase: 'degraded', degradedReasons: ['cloud_validation_failed'], registered: true });
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('refused the check-in body'));
    });

    it('does not relabel a rejected key as cloud_validation_failed when later check-ins only time out', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);
      await (service as any).validateRegistrationWithCloud();
      await later(PORTAL_REJECTION_CONFIRM_MS, () => (service as any).validateRegistrationWithCloud());
      expect(service.getRegistrationStatus().degradedReasons).toEqual(['portal_rejected']);

      mockedAxios.post.mockRejectedValue(new Error('timeout of 5000ms exceeded'));
      for (let attempt = 0; attempt < 4; attempt++) {
        await (service as any).validateRegistrationWithCloud();
      }

      expect(service.getRegistrationStatus().degradedReasons).toEqual(['portal_rejected']);
      expect(service.getRegistrationPhaseReport()).toMatchObject({
        consecutiveCheckInFailures: 4,
        lastCheckIn: { httpStatus: null, code: null, error: 'timeout of 5000ms exceeded' },
      });
    });

    it('does not rewrite the row or page the agent when a check-in re-asserts the same degraded state', async () => {
      // core-4 logged "Provisioning phase: degraded → degraded" and persisted it on every one of 130
      // failed check-ins in a row.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['portal_rejected']);
      deviceRegistrationRepository.updateProvisioningState.mockClear();

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Invalid Device Key', code: 'UNAUTHORIZED' } } as any);

      await (service as any).validateRegistrationWithCloud();
      await (service as any).validateRegistrationWithCloud();

      expect(deviceRegistrationRepository.updateProvisioningState).not.toHaveBeenCalled();
      expect(service.getRegistrationStatus().degradedReasons).toEqual(['portal_rejected']);

      // A different reason is a real change, and is still written.
      await service.setPhase('degraded', ['tunnel_token_missing']);
      expect(deviceRegistrationRepository.updateProvisioningState).toHaveBeenCalledWith('org-1', 'degraded', ['tunnel_token_missing']);
    });

    it('recovers from portal_rejected once a check-in passes with a fresh key, and records the success', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('degraded', ['portal_rejected']);

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'OK' } } as any);
      mockedAxios.head.mockResolvedValue({ status: 200 } as any);

      await (service as any).validateRegistrationWithCloud();

      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      expect(service.getRegistrationPhaseReport().lastCheckIn).toMatchObject({ httpStatus: 200, code: null, error: null });
    });

    // The drift probe asks WhoIs, not check-in (#1473), so a 401 is not a verdict: the Portal
    // answers a revoked key, a deleted device and a mistyped key alike. That is the same
    // conservative reading this branch gives Portal 401s on the check-in path, where
    // `classifyCheckInResponse` still calls one a rejection and the 10-minute wait confirms it.
    it('reads a 401 from the drift probe as "unknown", not as a verdict', async () => {
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Unauthorized', code: 'UNAUTHORIZED' } } as any);

      await expect((service as any).probePortalDeviceActive('test-device', 'http://cloud.api')).resolves.toBeNull();
    });

    describe('DEVICE_NOT_ACTIVE for a registration replaced while the check-in was in flight', () => {
      const useDeviceKey = (key: string) =>
        configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', ciHubApiKey: key, userSettings: { domain: 'example.com' } } as any);

      /** Sends a check-in with the current device key and holds the Portal's DEVICE_NOT_ACTIVE until `answer` is called. */
      const startCheckIn = async () => {
        await service.setPhase('paired');
        await service.setPhase('provisioning');
        await service.setPhase('locally_ready');
        vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
        vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);
        deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);

        let resolveAnswer: (value: unknown) => void = () => {};
        mockedAxios.post.mockReturnValueOnce(new Promise((resolve) => (resolveAnswer = resolve)) as any);
        const outcome = (service as any).validateRegistrationWithCloud() as Promise<string>;
        await vi.waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));

        return {
          outcome,
          answer: () => resolveAnswer({ status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } }),
        };
      };

      afterEach(() => {
        service.onApplicationShutdown();
      });

      it('keeps a registration paired again with a new key', async () => {
        const { outcome, answer } = await startCheckIn();

        await service.resetRegistration();
        useDeviceKey('new-api-key');
        await service.setPhase('locally_ready');
        deviceRegistrationRepository.deleteAll.mockClear();

        answer();

        await expect(outcome).resolves.toBe('skipped');
        expect(service.getRegistrationStatus().phase).toBe('locally_ready');
        expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      });

      it('keeps the registration when only the device key changed', async () => {
        const { outcome, answer } = await startCheckIn();

        useDeviceKey('new-api-key');
        answer();

        await expect(outcome).resolves.toBe('skipped');
        expect(service.getRegistrationStatus().phase).toBe('locally_ready');
        expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      });

      it('keeps a registration cleared and saved again with the same key', async () => {
        const { outcome, answer } = await startCheckIn();

        await service.resetRegistration();
        await service.setPhase('locally_ready');
        deviceRegistrationRepository.deleteAll.mockClear();

        answer();

        await expect(outcome).resolves.toBe('skipped');
        expect(service.getRegistrationStatus().phase).toBe('locally_ready');
        expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      });

      it('keeps a registration written again over the existing row with the same key', async () => {
        const { outcome, answer } = await startCheckIn();

        deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue({ id: 'org-1', hubSubdomain: 'hub-org' } as any);
        await (service as any).setupOrganizationInfrastructure('org-1', {
          organization_name: 'Org',
          tunnel_id: 'tunnel-2',
          tunnel_token: 'token-2',
          slug: 'org',
          subdomain: 'hub-org',
        });

        answer();

        await expect(outcome).resolves.toBe('skipped');
        expect(service.getRegistrationStatus().phase).toBe('locally_ready');
        expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      });

      it('still resets when the registration did not change', async () => {
        const { outcome, answer } = await startCheckIn();

        answer();

        await expect(outcome).resolves.toBe('removed');
        expect(service.getRegistrationStatus().phase).toBe('unregistered');
        expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps the registration on a 400 without the DEVICE_NOT_ACTIVE code, and counts it as a failure', async () => {
      // A schema refusal: the Portal did not like a field this Hub sent. Unpairing over that would
      // take a healthy Hub offline, so it is treated like any other failed check-in.
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 400, data: { success: false, error: { name: 'ZodError' } } } as any);

      await expect((service as any).validateRegistrationWithCloud()).resolves.toBe('failed');
      await (service as any).validateRegistrationWithCloud();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();

      await (service as any).validateRegistrationWithCloud();

      expect(service.getRegistrationStatus().phase).toBe('degraded');
      expect(service.getRegistrationStatus().degradedReasons).toContain('cloud_validation_failed');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('keeps the registration when a 400 body carries a different code', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 400, data: { error: 'Nope', code: 'SOMETHING_ELSE' } } as any);

      await expect((service as any).validateRegistrationWithCloud()).resolves.toBe('failed');
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('never resets on a 401: a refused device key counts as a failure, not a removal', async () => {
      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');

      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Unauthorized' } } as any);

      await expect((service as any).validateRegistrationWithCloud()).resolves.toBe('key_refused');
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
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

    // The drift probe used to ask check-in, where a coded 400 meant an inactive
    // device. It now asks WhoIs, which has no such answer, so neither 400 is
    // conclusive. Only `true` ever raised a drift signal, so nothing regressed.
    // Check-in itself still honours the coded 400 — see the sibling cases above.
    it('treats no 400 as conclusive in the drift probe, coded or not', async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 400, data: { code: 'DEVICE_NOT_ACTIVE' } } as any);
      await expect((service as any).probePortalDeviceActive('test-device', 'http://cloud.api')).resolves.toBeNull();

      mockedAxios.post.mockResolvedValueOnce({ status: 400, data: { success: false } } as any);
      await expect((service as any).probePortalDeviceActive('test-device', 'http://cloud.api')).resolves.toBeNull();
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

  describe('public reachability after registration', () => {
    const HUB_HOSTNAME = 'hub-core-2-demopool1.ci.computer';

    beforeEach(() => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', ciHubApiKey: 'test-api-key', domain: 'ci.computer' } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: 'org-1',
        hubSubdomain: 'hub-core-2-demopool1',
        provisioningPhase: 'locally_ready',
        degradedReasons: null,
      } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'OK' } } as any);
    });

    it('moves a Hub restored as locally_ready to publicly_ready once a check-in finds its public URL answering', async () => {
      // The fleet on 2026-09-27: registration gave up inside a cached NXDOMAIN, the phase was
      // persisted, and every check-in since only logged. A restart restores the same phase.
      await (service as any).syncPhaseFromDb();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      mockedProbe.mockResolvedValue({ reachable: true, via: 'zone_nameservers', status: 200 });

      await (service as any).validateRegistrationWithCloud();

      await vi.waitFor(() => expect(service.getRegistrationStatus().phase).toBe('publicly_ready'));
      expect(mockedProbe).toHaveBeenCalledWith(HUB_HOSTNAME);
      expect(deviceRegistrationRepository.updateProvisioningState).toHaveBeenCalledWith('org-1', 'publicly_ready', []);
      expect(loggerService.info).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${HUB_HOSTNAME} answered .*zone's nameservers`)));
    });

    it('keeps locally_ready, and logs which path failed, while the public URL gives no 2xx', async () => {
      await (service as any).syncPhaseFromDb();
      mockedProbe.mockResolvedValue({ reachable: false, via: 'system', detail: 'no response within 5000 ms' });

      await (service as any).validateRegistrationWithCloud();

      await vi.waitFor(() =>
        expect(loggerService.warn).toHaveBeenCalledWith(
          expect.stringContaining(`${HUB_HOSTNAME} not yet reachable (through this host's resolver; no response`),
        ),
      );
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
      expect(deviceRegistrationRepository.updateProvisioningState).not.toHaveBeenCalledWith('org-1', 'publicly_ready', expect.anything());
    });

    it('does not promote a Hub that turned degraded while the probe was out, which would erase the reason', async () => {
      await (service as any).syncPhaseFromDb();
      mockedProbe.mockImplementation(async () => {
        await service.setPhase('degraded', ['cloud_validation_failed']);
        return { reachable: true, via: 'system', status: 200 };
      });

      await (service as any).checkPublicReachability();

      expect(service.getRegistrationStatus()).toEqual({ phase: 'degraded', degradedReasons: ['cloud_validation_failed'], registered: true });
    });

    it('does not promote on a probe that started before the Hub was paired again', async () => {
      await (service as any).syncPhaseFromDb();
      mockedProbe.mockImplementation(async () => {
        (service as any).registrationGeneration++;
        return { reachable: true, via: 'system', status: 200 };
      });

      await (service as any).checkPublicReachability();

      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
    });

    it('runs one probe at a time, however often status polling checks in', async () => {
      await (service as any).syncPhaseFromDb();
      let answer: (value: { reachable: boolean; via: 'system'; status: number }) => void = () => {};
      mockedProbe.mockReturnValue(new Promise((resolve) => (answer = resolve)));

      // Counted by hostname: a registration loop another test left running shares this mock.
      const probesOfThisHub = () => mockedProbe.mock.calls.filter(([hostname]) => hostname === HUB_HOSTNAME).length;

      const first = (service as any).checkPublicReachability();
      const second = (service as any).checkPublicReachability();
      await vi.waitFor(() => expect(probesOfThisHub()).toBe(1));
      answer({ reachable: true, via: 'system', status: 200 });
      await Promise.all([first, second]);

      expect(probesOfThisHub()).toBe(1);
      expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
    });

    describe('once publicly_ready', () => {
      const UNREACHABLE = { reachable: false, via: 'system', detail: 'HTTP 530' } as const;
      const REACHABLE = { reachable: true, via: 'system', status: 200 } as const;

      beforeEach(async () => {
        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
          id: 'org-1',
          hubSubdomain: 'hub-core-2-demopool1',
          provisioningPhase: 'publicly_ready',
          degradedReasons: null,
        } as any);
        await (service as any).syncPhaseFromDb();
        expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
      });

      it('goes on probing the public URL on every accepted check-in', async () => {
        // This used to stop at promotion, so a tunnel that broke afterwards was never noticed.
        mockedProbe.mockResolvedValue(REACHABLE);

        await (service as any).validateRegistrationWithCloud();

        await vi.waitFor(() => expect(mockedProbe).toHaveBeenCalledWith(HUB_HOSTNAME));
      });

      it('reports tunnel_unreachable once the public URL has failed for ten minutes, and not on the first failure', async () => {
        mockedProbe.mockResolvedValue(UNREACHABLE);

        await (service as any).checkPublicReachability();
        expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
        expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining(`${HUB_HOSTNAME} stopped answering`));

        await later(PUBLIC_UNREACHABLE_CONFIRM_MS, () => (service as any).checkPublicReachability());

        expect(service.getRegistrationStatus()).toEqual({ phase: 'degraded', degradedReasons: ['tunnel_unreachable'], registered: true });
        expect(deviceRegistrationRepository.updateProvisioningState).toHaveBeenCalledWith('org-1', 'degraded', ['tunnel_unreachable']);
      });

      it('starts the ten minutes again after any 2xx', async () => {
        mockedProbe.mockResolvedValue(UNREACHABLE);
        await (service as any).checkPublicReachability();
        mockedProbe.mockResolvedValue(REACHABLE);
        await later(5 * 60_000, () => (service as any).checkPublicReachability());
        mockedProbe.mockResolvedValue(UNREACHABLE);
        await later(11 * 60_000, () => (service as any).checkPublicReachability());

        expect(service.getRegistrationStatus().phase).toBe('publicly_ready');

        await later(22 * 60_000, () => (service as any).checkPublicReachability());

        expect(service.getRegistrationStatus().phase).toBe('degraded');
      });

      it('is promoted again by the check-in after the URL answers once more', async () => {
        mockedProbe.mockResolvedValue(UNREACHABLE);
        await (service as any).checkPublicReachability();
        await later(PUBLIC_UNREACHABLE_CONFIRM_MS, () => (service as any).checkPublicReachability());
        expect(service.getRegistrationStatus().phase).toBe('degraded');

        // An accepted check-in takes `degraded` back to `locally_ready`, and its probe promotes.
        mockedProbe.mockResolvedValue(REACHABLE);
        await (service as any).validateRegistrationWithCloud();

        await vi.waitFor(() => expect(service.getRegistrationStatus()).toEqual({ phase: 'publicly_ready', degradedReasons: [], registered: true }));
      });

      it('does not demote on a probe that started before the Hub was paired again', async () => {
        mockedProbe.mockResolvedValue(UNREACHABLE);
        await (service as any).checkPublicReachability();
        mockedProbe.mockImplementation(async () => {
          (service as any).registrationGeneration++;
          return UNREACHABLE;
        });

        await later(PUBLIC_UNREACHABLE_CONFIRM_MS, () => (service as any).checkPublicReachability());

        expect(service.getRegistrationStatus().phase).toBe('publicly_ready');
      });
    });
  });

  describe('tunnel follows the registration', () => {
    const registeredRow = {
      id: 'org-1',
      name: 'Org',
      slug: 'org',
      hubSubdomain: 'hub-org',
      tunnelId: 'tunnel-registered',
      tunnelToken: 'registered-token',
      provisioningPhase: 'locally_ready',
      degradedReasons: '[]',
    };

    beforeEach(() => {
      vol.mkdirSync(TUNNEL_DIR, { recursive: true });
      cloudflareClientService.stopTunnel.mockResolvedValue(true);
      cloudflareClientService.loadTunnelTokenFromDisk.mockResolvedValue(true);
      cloudflareClientService.ensureCloudflaredRunning.mockResolvedValue(true);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);
    });

    afterEach(() => {
      service.onApplicationShutdown();
    });

    const expectConnectorNeverStarted = () => {
      expect(cloudflareClientService.ensureCloudflaredRunning).not.toHaveBeenCalled();
      expect(cloudflareClientService.initializeTunnel).not.toHaveBeenCalled();
      expect(cloudflareClientService.loadTunnelTokenFromDisk).not.toHaveBeenCalled();
    };

    it('stops the connector and sets a leftover token aside when an unregistered Hub boots with one', async () => {
      // The reported case: a reinstall kept the previous Hub's token and joined its tunnel before pairing.
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-previous-hub'));
      vol.writeFileSync(REGISTRATION_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-previous-hub', writtenAt: '2026-09-01T00:00:00.000Z' }));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await (service as any).runDeferredBootstrap();

      expectConnectorNeverStarted();
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(TOKEN_PATH)).toBe(false);
      expect(readJson(LEFTOVER_MARKER_PATH)).toEqual({ tunnelId: 'tunnel-previous-hub', foundAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(readJson(LEFTOVER_MARKER_PATH).foundAt as string))).toBe(false);
      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(false);
      expect(service.getRegistrationStatus().phase).toBe('unregistered');
    });

    it('records a leftover token it cannot decode with no tunnel ID', async () => {
      vol.writeFileSync(TOKEN_PATH, 'opaque-token');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await (service as any).runDeferredBootstrap();

      expect(readJson(LEFTOVER_MARKER_PATH).tunnelId).toBeNull();
      expect(vol.existsSync(TOKEN_PATH)).toBe(false);
    });

    it('leaves an unregistered Hub with no token alone', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await (service as any).runDeferredBootstrap();

      expectConnectorNeverStarted();
      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('removes a stale registration.json from an unregistered Hub with no token', async () => {
      // A token restored beside it later would otherwise start that tunnel from the desktop app or CLI.
      vol.writeFileSync(REGISTRATION_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-previous-hub', writtenAt: '2026-09-01T00:00:00.000Z' }));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await (service as any).runDeferredBootstrap();

      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(false);
      expectConnectorNeverStarted();
      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('still sets a leftover token aside when registration.json cannot be removed, and logs why', async () => {
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-previous-hub'));
      // A directory in the marker's place makes the unlink fail.
      vol.mkdirSync(path.join(REGISTRATION_MARKER_PATH, 'blocker'), { recursive: true });
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);

      await (service as any).syncTunnelWithRegistration();

      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('Could not remove the tunnel registration marker'));
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(TOKEN_PATH)).toBe(false);
      expect(readJson(LEFTOVER_MARKER_PATH).tunnelId).toBe('tunnel-previous-hub');
    });

    it('neither starts nor stops anything when the registration cannot be read, and retries on the next check', async () => {
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-unknown'));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockRejectedValue(new Error('database starting up'));
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockRejectedValue(new Error('database starting up'));
      const pollSpy = vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await (service as any).runDeferredBootstrap();

      expectConnectorNeverStarted();
      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.existsSync(TOKEN_PATH)).toBe(true);
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(false);
      expect(pollSpy).toHaveBeenCalledOnce();

      // The database answers on the next registration check: still no registration.
      pollSpy.mockRestore();
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'checkRegistrationWithCloud').mockResolvedValue(false);

      await (service as any).pollRegistration();

      expectConnectorNeverStarted();
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(TOKEN_PATH)).toBe(false);
      expect(readJson(LEFTOVER_MARKER_PATH).tunnelId).toBe('tunnel-unknown');
    });

    it('starts the tunnel of a registered Hub whose boot-time read failed at its next validation', async () => {
      vol.writeFileSync(TOKEN_PATH, 'registered-token');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockRejectedValueOnce(new Error('database starting up'));
      await (service as any).syncTunnelWithRegistration();
      expect(cloudflareClientService.ensureCloudflaredRunning).not.toHaveBeenCalled();

      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(registeredRow as any);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      (service as any)._currentPhase = 'locally_ready';
      mockedAxios.post.mockResolvedValue({ status: 200 } as any);
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');

      await (service as any).validateRegistrationWithCloud();

      expect(cloudflareClientService.ensureCloudflaredRunning).toHaveBeenCalledOnce();
      expect(readJson(REGISTRATION_MARKER_PATH).tunnelId).toBe('tunnel-registered');

      // Once the check has run, validation does not repeat it.
      await (service as any).validateRegistrationWithCloud();
      expect(cloudflareClientService.ensureCloudflaredRunning).toHaveBeenCalledOnce();
    });

    it('does not touch the token or registration.json of a pairing in progress', async () => {
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-being-paired'));
      vol.writeFileSync(REGISTRATION_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-being-paired', writtenAt: '2026-09-17T00:00:00.000Z' }));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      (service as any)._currentPhase = 'provisioning';

      await (service as any).syncTunnelWithRegistration();

      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.existsSync(TOKEN_PATH)).toBe(true);
      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(true);
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('does not stop the connector of a pairing that starts while the token is being read', async () => {
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-previous-hub'));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'readTunnelToken').mockImplementation(async () => {
        (service as any)._currentPhase = 'paired';
        return cloudflaredToken('tunnel-previous-hub');
      });

      await (service as any).syncTunnelWithRegistration();

      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.existsSync(TOKEN_PATH)).toBe(true);
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('keeps the token of a pairing that finishes while the leftover connector is being removed', async () => {
      vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-previous-hub'));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      cloudflareClientService.stopTunnel.mockImplementation(async () => {
        // `docker rm` can take seconds. A pairing saves its token and registration in the meantime.
        vol.writeFileSync(TOKEN_PATH, cloudflaredToken('tunnel-just-paired'));
        vol.writeFileSync(REGISTRATION_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-just-paired', writtenAt: '2026-09-17T00:00:00.000Z' }));
        (service as any)._currentPhase = 'locally_ready';
        return true;
      });

      await (service as any).syncTunnelWithRegistration();

      expect(vol.readFileSync(TOKEN_PATH, 'utf-8')).toBe(cloudflaredToken('tunnel-just-paired'));
      expect(readJson(REGISTRATION_MARKER_PATH).tunnelId).toBe('tunnel-just-paired');
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('writes registration.json for an existing registered Hub and starts its connector as before', async () => {
      vol.writeFileSync(TOKEN_PATH, 'registered-token');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(registeredRow as any);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(true);
      vi.spyOn(service as any, 'validateRegistrationWithCloud').mockResolvedValue(undefined);
      vi.spyOn(service as any, 'startPeriodicValidation').mockReturnValue(undefined);

      await (service as any).runDeferredBootstrap();

      expect(readJson(REGISTRATION_MARKER_PATH)).toEqual({ tunnelId: 'tunnel-registered', writtenAt: expect.any(String) });
      expect(cloudflareClientService.loadTunnelTokenFromDisk).toHaveBeenCalledWith('tunnel-registered');
      expect(cloudflareClientService.ensureCloudflaredRunning).toHaveBeenCalledWith({ forceRestart: false });
      expect(cloudflareClientService.stopTunnel).not.toHaveBeenCalled();
      expect(vol.readFileSync(TOKEN_PATH, 'utf-8')).toBe('registered-token');
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
    });

    it('writes registration.json once a pairing saves its registration', async () => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      configService.setDomain.mockResolvedValue(undefined);
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      deviceRegistrationRepository.createDeviceRegistration.mockResolvedValue({} as any);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 'tunnel-pair', token: 'token-pair' });
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: {
          device_id: 'test-device',
          organization_id: 'org-pair',
          organization_name: 'Paired Org',
          slug: 'paired-org',
          subdomain: 'hub-paired-org',
          tunnel_id: 'tunnel-pair',
          tunnel_token: 'token-pair',
          api_key: 'key-pair',
          domain: 'example.com',
        },
      } as any);

      const result = await service.pairDevice('ABC123');

      expect(result.success).toBe(true);
      await vi.waitFor(() => expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(true));
      expect(deviceRegistrationRepository.createDeviceRegistration).toHaveBeenCalled();
      expect(readJson(REGISTRATION_MARKER_PATH).tunnelId).toBe('tunnel-pair');
    });

    it('writes registration.json when a registration callback lands on an existing row', async () => {
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue({ ...registeredRow, tunnelId: 'tunnel-old' } as any);
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'http://cloud.api', domain: 'example.com' } as any);

      await (service as any).setupOrganizationInfrastructure('org-1', {
        organization_name: 'Org',
        tunnel_id: 'tunnel-new',
        tunnel_token: 'token-new',
        subdomain: 'hub-org',
        slug: 'org',
      });

      expect(readJson(REGISTRATION_MARKER_PATH).tunnelId).toBe('tunnel-new');
    });

    it('removes leftover.json when a registration is saved, so a later reset does not offer to reconnect a stale tunnel', async () => {
      const leftover = JSON.stringify({ tunnelId: 'tunnel-previous-hub', foundAt: '2026-09-01T00:00:00.000Z' });
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        domain: 'example.com',
        userSettings: { domain: 'example.com' },
      } as any);
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      configService.setDomain.mockResolvedValue(undefined);
      cloudflareClientService.initializeTunnel.mockResolvedValue({ tunnelId: 'tunnel-new', token: 'token-new' });
      mockedProbe.mockResolvedValue({ reachable: true, via: 'system', status: 200 });
      const activation = { organization_name: 'Org', tunnel_id: 'tunnel-new', tunnel_token: 'token-new', subdomain: 'hub-org', slug: 'org' };

      // A new registration row.
      vol.writeFileSync(LEFTOVER_MARKER_PATH, leftover);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(null as any);
      deviceRegistrationRepository.createDeviceRegistration.mockResolvedValue({} as any);
      await (service as any).setupOrganizationInfrastructure('org-1', activation);
      expect(deviceRegistrationRepository.createDeviceRegistration).toHaveBeenCalled();
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);

      // An existing registration row.
      vol.writeFileSync(LEFTOVER_MARKER_PATH, leftover);
      deviceRegistrationRepository.getDeviceRegistrationById.mockResolvedValue(registeredRow as any);
      await (service as any).setupOrganizationInfrastructure('org-1', activation);
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);

      // Reset from Settings: the registration page shows no stale tunnel.
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);
      await service.resetRegistration();
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ status: 401 } as any);

      const drift = await service.getStateDrift();
      expect(drift.hasStaleTunnelToken).toBe(false);
      expect(drift.signals.map((signal) => signal.reason)).not.toContain('stale_tunnel_token');
    });

    it('stops the connector and removes the token and registration.json on reset, keeping the device key', async () => {
      vol.writeFileSync(TOKEN_PATH, 'registered-token');
      vol.writeFileSync(REGISTRATION_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-registered', writtenAt: '2026-09-01T00:00:00.000Z' }));
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(registeredRow as any);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await service.resetRegistration();

      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(TOKEN_PATH)).toBe(false);
      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(false);
      expect(configService.setUserSettings).not.toHaveBeenCalled();
    });

    it('stops the connector when the Portal rejects the check-in', async () => {
      vol.writeFileSync(TOKEN_PATH, 'registered-token');
      vol.writeFileSync(REGISTRATION_MARKER_PATH, '{}');
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(registeredRow as any);
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);
      (service as any)._currentPhase = 'publicly_ready';
      mockedAxios.post.mockResolvedValue({ status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } } as any);

      await (service as any).validateRegistrationWithCloud();

      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(REGISTRATION_MARKER_PATH)).toBe(false);
    });

    it('retries stopping the connector on the next check when a reset could not stop it', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      cloudflareClientService.stopTunnel.mockResolvedValueOnce(false);
      vi.spyOn(service as any, 'checkRegistrationWithCloud').mockResolvedValue(false);

      await service.resetRegistration();
      // The registration check that the reset starts retries the stop.
      await vi.waitFor(() => expect((service as any).checkInterval).not.toBeNull());
      service.onApplicationShutdown();
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledTimes(2);

      // Stopped on the retry, so later checks leave the connector alone.
      await (service as any).pollRegistration();
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledTimes(2);
    });

    it('removes leftover.json on Start fresh', async () => {
      vol.writeFileSync(LEFTOVER_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-previous-hub', foundAt: '2026-09-01T00:00:00.000Z' }));
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      const result = await service.prepareFreshSetup();

      expect(result.success).toBe(true);
      expect(cloudflareClientService.stopTunnel).toHaveBeenCalledOnce();
      expect(vol.existsSync(LEFTOVER_MARKER_PATH)).toBe(false);
    });

    it('reports a stale tunnel token from leftover.json after the token itself is gone', async () => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ status: 401 } as any);

      const before = await service.getStateDrift();
      expect(before.signals.map((signal) => signal.reason)).not.toContain('stale_tunnel_token');

      vol.writeFileSync(LEFTOVER_MARKER_PATH, JSON.stringify({ tunnelId: 'tunnel-previous-hub', foundAt: '2026-09-01T00:00:00.000Z' }));

      const after = await service.getStateDrift();
      expect(after.detected).toBe(true);
      expect(after.hasStaleTunnelToken).toBe(true);
      expect(after.signals.map((signal) => signal.reason)).toContain('stale_tunnel_token');
    });

    it('says whether this Hub holds a move key, and never what it is', async () => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      configService.getOutboundCiCloudUrl.mockReturnValue('http://cloud.api');
      deviceRegistrationRepository.hasAnyDeviceRegistration.mockResolvedValue(false);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);
      mockedAxios.post.mockResolvedValue({ status: 401 } as any);
      const config = configService.getConfig();

      configService.getConfig.mockReturnValue({ ...config, ciHubMoveKey: 'stored-move-key' } as any);
      const holding = await service.getStateDrift();
      expect(holding.hasMoveKey).toBe(true);
      expect(JSON.stringify(holding)).not.toContain('stored-move-key');

      configService.getConfig.mockReturnValue({ ...config, ciHubMoveKey: null } as any);
      expect((await service.getStateDrift()).hasMoveKey).toBe(false);
    });
  });

  describe('resetRegistration', () => {
    it('clears only local state and never contacts the Portal', async () => {
      deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);

      await service.resetRegistration();

      expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(service.getRegistrationStatus().phase).toBe('unregistered');
    });
  });

  describe('checkForRemoval', () => {
    const DEVICE_NOT_ACTIVE = { status: 400, data: { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' } };

    beforeEach(async () => {
      vi.spyOn(service, 'getDeviceId').mockResolvedValue('test-device');
      vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(true);
      vi.spyOn(service as any, 'pollRegistration').mockResolvedValue(undefined);
      configService.getConfig.mockReturnValue({
        ciCloudUrl: 'http://cloud.api',
        ciHubApiKey: 'test-api-key',
        userSettings: { domain: 'example.com' },
      } as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      deviceRegistrationRepository.updateProvisioningState.mockResolvedValue({} as any);
      deviceRegistrationRepository.deleteAll.mockResolvedValue(undefined);
      mockedAxios.head.mockResolvedValue({ status: 200 } as any);

      await service.setPhase('paired');
      await service.setPhase('provisioning');
      await service.setPhase('locally_ready');
    });

    afterEach(() => {
      vi.useRealTimers();
      service.onApplicationShutdown();
    });

    it('resets the Hub and reports removed when the Portal answers DEVICE_NOT_ACTIVE', async () => {
      mockedAxios.post.mockResolvedValue(DEVICE_NOT_ACTIVE as any);

      await expect(service.checkForRemoval()).resolves.toBe('removed');

      expect(deviceRegistrationRepository.deleteAll).toHaveBeenCalled();
      expect(service.getRegistrationStatus().phase).toBe('unregistered');
    });

    it('reports still_registered while the Portal accepts the device', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'active' } } as any);

      await expect(service.checkForRemoval()).resolves.toBe('still_registered');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('reports key_refused on a 401 and resets nothing', async () => {
      mockedAxios.post.mockResolvedValue({ status: 401, data: { error: 'Unauthorized' } } as any);

      await expect(service.checkForRemoval()).resolves.toBe('key_refused');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
      expect(service.getRegistrationStatus().phase).toBe('locally_ready');
    });

    it('reports not_checked when the Portal cannot be reached', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      await expect(service.checkForRemoval()).resolves.toBe('not_checked');
      expect(deviceRegistrationRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('sends at most one check-in per 30 seconds, answering from the last one in between', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      mockedAxios.post.mockResolvedValue({ status: 200, data: { status: 'active' } } as any);

      await expect(service.checkForRemoval()).resolves.toBe('still_registered');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      // The Settings page asks every 15 seconds; the second ask rides on the first answer.
      vi.advanceTimersByTime(15_000);
      mockedAxios.post.mockResolvedValue(DEVICE_NOT_ACTIVE as any);
      await expect(service.checkForRemoval()).resolves.toBe('still_registered');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15_001);
      await expect(service.checkForRemoval()).resolves.toBe('removed');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('shares a check-in already in flight instead of sending a second one', async () => {
      let answer: (value: unknown) => void = () => {};
      mockedAxios.post.mockReturnValue(new Promise((resolve) => (answer = resolve)) as any);

      const first = service.checkForRemoval();
      const second = service.checkForRemoval();
      await vi.waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(1));
      answer(DEVICE_NOT_ACTIVE);

      await expect(first).resolves.toBe('removed');
      await expect(second).resolves.toBe('removed');
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('reports removed without calling the Portal when the Hub is already unregistered', async () => {
      await service.setPhase('unregistered');

      await expect(service.checkForRemoval()).resolves.toBe('removed');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });
});
