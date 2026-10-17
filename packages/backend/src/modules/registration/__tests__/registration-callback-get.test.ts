/**
 * The deprecated GET callback, driven through the real controller and the real service over one
 * set of settings and table rows, so a refusal is checked by what it leaves behind.
 *
 * Its one caller is CI-OS's headless setup service, which runs on the host and calls the Hub's
 * published port at `http://127.0.0.1:5002`. The Hub sees that request from a bridge gateway with
 * that Host header and no forwarding headers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { TailscaleService } from '../../tailscale/tailscale.service';

vi.mock('axios');
// These write under DATA_DIR through `node:fs/promises`, which the suite's memfs does not cover.
vi.mock('../../app-lifecycle/registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-lifecycle/registration-recovery-state')>()),
  writePairingAppCheck: vi.fn(),
  clearRehydrationState: vi.fn(),
}));
// The registration probes the new hostname; no unit test may reach the network.
vi.mock('../public-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-reachability')>()),
  probePublicHostname: vi.fn().mockResolvedValue({ reachable: true }),
}));

// The Hub as it runs on an appliance: in a container whose default gateway is 172.18.0.1, where the
// setup service's requests from the host arrive from.
vi.mock('@/common/helpers/this-host-address', async (importOriginal) =>
  (await import('@/tests/utils/appliance-host-address')).onAppliance(await importOriginal()),
);

const DEVICE_ID = 'device-test-1';

type Row = Record<string, unknown> & { id: string };

let controller: RegistrationController;
let service: RegistrationService;
let settings: Record<string, unknown>;
let rows: Row[];
let config: MockProxy<ConfigurationService>;
let cloudflare: MockProxy<CloudflareClientService>;
let traefik: MockProxy<TraefikConfigService>;

function request(ip: string, host: string, headers: Record<string, string> = {}) {
  const all: Record<string, string> = { host, ...headers };
  return { ip, socket: { remoteAddress: ip }, headers: all, protocol: 'http', get: (name: string) => all[name.toLowerCase()] } as any;
}

/** What the setup service's request looks like to the Hub. */
const fromSetupService = () => request('172.18.0.1', '127.0.0.1:5002');
const fromLan = () => request('192.168.1.50', '192.168.1.10:5002');
/** A machine on the LAN that names this Hub's loopback address, which its own address gives away. */
const fromLanNamingLoopback = () => request('192.168.1.50', '127.0.0.1:5002');
const throughTunnel = () =>
  request('172.18.0.1', 'hub.example.com', {
    'cf-ray': '8f00000000000000-LHR',
    'x-forwarded-host': '127.0.0.1:5002',
    'x-forwarded-for': '203.0.113.9',
  });
const throughTraefik = () => request('172.19.0.3', 'hub.example.com', { 'x-forwarded-host': 'hub.example.com', 'x-forwarded-for': '192.168.1.50' });

const sendGet = (from: unknown, organizationId = 'org-new') =>
  controller.handleCallback(from as any, DEVICE_ID, organizationId, 'New Org', 'new-org', 'new-sub', 'tun-new', 'tok-new', 'key-new', 'new.example');

const BODY = {
  device_id: DEVICE_ID,
  organization_id: 'org-new',
  organization_name: 'New Org',
  slug: 'new-org',
  subdomain: 'new-sub',
  tunnel_id: 'tun-new',
  tunnel_token: 'tok-new',
  api_key: 'key-new',
  domain: 'new.example',
};

function startServing() {
  settings.ciHubApiKey = 'key-current';
  settings.ciHubOrganizationId = 'org-current';
  rows.push({
    id: 'org-current',
    slug: 'current',
    name: 'Current',
    hubSubdomain: 'current-sub',
    tunnelId: 'tun-current',
    tunnelToken: 'tok-current',
  });
  (service as any)._currentPhase = 'publicly_ready';
}

/** Everything a callback writes, to compare before and after a refusal. */
const snapshot = () => ({ settings: structuredClone(settings), rows: structuredClone(rows), phase: (service as any)._currentPhase });

function expectNothingWritten() {
  expect(config.setFileOnlySettings).not.toHaveBeenCalled();
  expect(config.setUserSettings).not.toHaveBeenCalled();
  expect(config.setDomain).not.toHaveBeenCalled();
  expect(cloudflare.initializeTunnel).not.toHaveBeenCalled();
  expect(traefik.writeHubRoute).not.toHaveBeenCalled();
}

beforeEach(async () => {
  settings = { ciCloudUrl: 'https://portal.example.com', domain: 'current.example', userSettings: { domain: 'current.example' } };
  rows = [];

  config = mock<ConfigurationService>();
  config.getConfig.mockImplementation(() => ({ ...settings }) as any);
  config.get.mockImplementation(((key: string) => settings[key]) as any);
  config.setFileOnlySettings.mockImplementation((async (patch: Record<string, unknown>) => Object.assign(settings, patch)) as any);
  config.setUserSettings.mockImplementation((async (patch: Record<string, unknown>) => Object.assign(settings, patch)) as any);
  config.setDomain.mockImplementation(async (domain: string) => {
    settings.domain = domain;
    settings.userSettings = { domain };
  });

  const repository = mock<DeviceRegistrationRepository>();
  repository.getFirstDeviceRegistration.mockImplementation(async () => (rows[0] ?? null) as any);
  repository.getDeviceRegistrationById.mockImplementation(async (id: string) => (rows.find((row) => row.id === id) ?? null) as any);
  repository.hasAnyDeviceRegistration.mockImplementation(async () => rows.length > 0);
  repository.createDeviceRegistration.mockImplementation((async (row: Row) => {
    rows.push({ ...row });
  }) as any);
  repository.updateDeviceRegistration.mockImplementation((async (id: string, patch: Record<string, unknown>) => {
    Object.assign(rows.find((row) => row.id === id) ?? {}, patch);
  }) as any);
  repository.updateProvisioningState.mockResolvedValue(undefined as any);

  cloudflare = mock<CloudflareClientService>();
  cloudflare.initializeTunnel.mockImplementation(async (_organizationId, credentials) => ({
    tunnelId: credentials.tunnelId,
    token: credentials.token,
  }));
  traefik = mock<TraefikConfigService>();

  const moduleRef = await Test.createTestingModule({
    controllers: [RegistrationController],
    providers: [
      RegistrationService,
      { provide: ConfigurationService, useValue: config },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: CloudflareClientService, useValue: cloudflare },
      { provide: TraefikConfigService, useValue: traefik },
      { provide: DeviceRegistrationRepository, useValue: repository },
      { provide: RepoEventsQueue, useValue: mock<RepoEventsQueue>() },
      { provide: PortalClientService, useValue: mock<PortalClientService>() },
      { provide: TailscaleService, useValue: mock<TailscaleService>() },
    ],
  }).compile();

  controller = moduleRef.get(RegistrationController);
  service = moduleRef.get(RegistrationService);
  // The token file and the host's machine ID live outside the in-memory state this test owns.
  vi.spyOn(service as any, 'hasTunnelToken').mockImplementation(() => rows.length > 0);
  vi.spyOn(service as any, 'resolveDeviceId').mockResolvedValue(DEVICE_ID);
});

describe('GET /registration/callback on a Hub that is registered and serving', () => {
  it('is refused from the LAN, through the tunnel, through Traefik and from the setup service without changing anything', async () => {
    startServing();
    const before = snapshot();

    for (const from of [fromLan(), fromLanNamingLoopback(), throughTunnel(), throughTraefik(), fromSetupService()]) {
      await expect(sendGet(from)).rejects.toThrow(ForbiddenException);
      // The same organization would update the existing row in place rather than add one.
      await expect(sendGet(from, 'org-current')).rejects.toThrow(ForbiddenException);
    }

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });
});

describe('GET /registration/callback on a Hub that is not registered', () => {
  it('registers the Hub when the setup service sends it', async () => {
    await expect(sendGet(fromSetupService())).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(rows.map((row) => row.id)).toEqual(['org-new']));

    expect(settings.ciHubApiKey).toBe('key-new');
    expect(cloudflare.initializeTunnel).toHaveBeenCalledWith('org-new', { tunnelId: 'tun-new', token: 'tok-new' });
    await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
  });

  it('is refused from anywhere else without changing anything', async () => {
    const before = snapshot();

    for (const from of [fromLan(), fromLanNamingLoopback(), throughTunnel(), throughTraefik()]) {
      await expect(sendGet(from)).rejects.toThrow(ForbiddenException);
    }

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('still completes a re-pairing for a Hub that lost its tunnel token, which is how headless setup restores it', async () => {
    startServing();
    (service as any)._currentPhase = 'degraded';
    (service as any)._degradedReasons = ['tunnel_token_missing'];
    vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);

    await expect(sendGet(fromSetupService(), 'org-current')).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(rows[0]).toMatchObject({ tunnelToken: 'tok-new' }));
    // Let the background setup finish here rather than write into the next test's rows.
    await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
  });
});

describe('POST /registration/callback is unchanged', () => {
  it('completes a registration with its nonce, with no rule about where it came from', async () => {
    await expect(controller.handleCallbackPost(BODY, service.mintCallbackNonce(), fromLan())).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(rows.map((row) => row.id)).toEqual(['org-new']));
    await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
  });

  it('refuses a Hub that is registered and serving without changing anything', async () => {
    startServing();
    const before = snapshot();

    await expect(controller.handleCallbackPost(BODY, service.mintCallbackNonce())).rejects.toThrow(/already registered/);

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });
});
