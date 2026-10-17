/**
 * Who may pair a Hub that is registered but needs pairing again (`portal_rejected`,
 * `tunnel_token_missing`): through either registration callback route, or with a pairing code.
 * Driven through the real controller, `RegistrationService` and `MarketplaceWhoIsService` over one
 * set of settings and table rows, so a refusal is checked by what it leaves behind.
 *
 * Such a Hub is past the "already registered" refusal, because pairing again is how it recovers. A
 * `portal_rejected` Hub keeps its tunnel. The POST's nonce comes from an unauthenticated route, and
 * `POST /registration/pair` takes no credential for a first pairing. So both take someone who may
 * manage the Hub, or a request from the Hub's own machine, where CI-OS's headless setup service and
 * `cihub register` run.
 */
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DatabaseService } from '@/core/database/database.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
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
const OWNER_ID = 7;

type Row = Record<string, unknown> & { id: string };
type Caller = { hubPrincipal?: 'session' | 'portal-device' | 'cli' | 'host-local'; user?: { id: number; orgRole?: string | null } };

let controller: RegistrationController;
let service: RegistrationService;
let settings: Record<string, unknown>;
let rows: Row[];
let config: MockProxy<ConfigurationService>;
let cloudflare: MockProxy<CloudflareClientService>;
let traefik: MockProxy<TraefikConfigService>;
let portal: MockProxy<PortalClientService>;
let users: MockProxy<UserRepository>;

function request(ip: string, host: string, caller: Caller = {}) {
  const headers: Record<string, string> = { host };
  return { ip, socket: { remoteAddress: ip }, headers, protocol: 'http', get: (name: string) => headers[name.toLowerCase()], ...caller } as any;
}

const anonymousOnLan = () => request('192.168.1.50', '192.168.1.10:5002');
const lanNamingLoopback = () => request('192.168.1.50', '127.0.0.1:5002');
/** What the setup service's request looks like to the Hub: the gateway, a loopback Host and no session. */
const fromSetupService = () => request('172.18.0.1', '127.0.0.1:5002');
/** A person signed in to this Hub, using it from another machine on the LAN. */
const signedIn = (orgRole: string | null) =>
  request('192.168.1.50', '192.168.1.10:5002', { hubPrincipal: 'session', user: { id: OWNER_ID, orgRole } });
const memoryWithDeviceKey = () => request('192.168.1.50', '192.168.1.10:5002', { hubPrincipal: 'portal-device', user: { id: 1 } });

const BODY = {
  device_id: DEVICE_ID,
  organization_id: 'org-current',
  organization_name: 'Current',
  slug: 'current',
  subdomain: 'new-sub',
  tunnel_id: 'tun-new',
  tunnel_token: 'tok-new',
  api_key: 'key-new',
  domain: 'new.example',
};

const sendPost = (from: unknown) => controller.handleCallbackPost(BODY, service.mintCallbackNonce(), from as any);
const sendGet = (from: unknown) =>
  controller.handleCallback(from as any, DEVICE_ID, 'org-current', 'Current', 'current', 'new-sub', 'tun-new', 'tok-new', 'key-new', 'new.example');

/*
 * `POST /registration/pair` asks the same question before it sends the code to Portal. Portal is
 * mocked here, so a pairing that passes reaches `/api/devices/pair` and one that is refused never does.
 */
const mockedPost = vi.mocked(axios.post);
const portalPairCalls = () => mockedPost.mock.calls.filter(([url]) => String(url).endsWith('/api/devices/pair'));
const sendPair = (from: unknown, confirmMove = false) =>
  controller.pairDevice({ pairing_code: 'abc123', ...(confirmMove ? { confirm_move: true } : {}) }, from as any);

/** The Portal's answer about the person's role in this Hub's organization. */
const portalSays = (role: string) =>
  portal.whoisApps.mockResolvedValue({
    status: 200,
    body: { organizations: [{ organizationId: 'org-current', version: 1, user: { role }, apps: [] }] },
  } as any);
/** How the Portal answers a Hub whose device key it rejects. */
const portalRejectsDeviceKey = () => portal.whoisApps.mockResolvedValue({ status: 401, body: null } as any);

function registerThenDegrade(reason: 'portal_rejected' | 'tunnel_token_missing') {
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
  (service as any)._currentPhase = 'degraded';
  (service as any)._degradedReasons = [reason];
  // A `portal_rejected` Hub keeps its tunnel token. A `tunnel_token_missing` one has none on disk.
  vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(reason === 'portal_rejected');
}

/** Everything a callback writes, to compare before and after a refusal. */
const snapshot = () => ({
  settings: structuredClone(settings),
  rows: structuredClone(rows),
  phase: (service as any)._currentPhase,
  reasons: [...(service as any)._degradedReasons],
});

function expectNothingWritten() {
  expect(config.setFileOnlySettings).not.toHaveBeenCalled();
  expect(config.setUserSettings).not.toHaveBeenCalled();
  expect(config.setDomain).not.toHaveBeenCalled();
  expect(cloudflare.initializeTunnel).not.toHaveBeenCalled();
  expect(traefik.writeHubRoute).not.toHaveBeenCalled();
}

async function expectPairedAgain() {
  await vi.waitFor(() => expect(rows[0]).toMatchObject({ tunnelToken: 'tok-new' }));
  expect(settings.ciHubApiKey).toBe('key-new');
  // Let the background setup finish here rather than write into the next test's rows.
  await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
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
  portal = mock<PortalClientService>();

  const federatedIdentities = mock<FederatedIdentityRepository>();
  federatedIdentities.findByUserId.mockResolvedValue([{ subject: 'portal-user-7' }] as any);
  users = mock<UserRepository>();
  // Someone else claimed this Hub, so the person here follows their organization role.
  users.getFirstOperator.mockResolvedValue({ id: 1 } as any);

  const moduleRef = await Test.createTestingModule({
    controllers: [RegistrationController],
    providers: [
      RegistrationService,
      MarketplaceWhoIsService,
      { provide: ConfigurationService, useValue: config },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: CloudflareClientService, useValue: cloudflare },
      { provide: TraefikConfigService, useValue: traefik },
      { provide: DeviceRegistrationRepository, useValue: repository },
      { provide: RepoEventsQueue, useValue: mock<RepoEventsQueue>() },
      { provide: PortalClientService, useValue: portal },
      { provide: TailscaleService, useValue: mock<TailscaleService>() },
      { provide: DatabaseService, useValue: mock<DatabaseService>() },
      { provide: FederatedIdentityRepository, useValue: federatedIdentities },
      { provide: UserRepository, useValue: users },
    ],
  }).compile();

  controller = moduleRef.get(RegistrationController);
  service = moduleRef.get(RegistrationService);
  // The host's machine ID lives outside the in-memory state this test owns.
  vi.spyOn(service as any, 'resolveDeviceId').mockResolvedValue(DEVICE_ID);
  vi.spyOn(service as any, 'hasTunnelToken').mockImplementation(() => rows.length > 0);
});

describe.each(['portal_rejected', 'tunnel_token_missing'] as const)('a registration callback on a %s Hub', (reason) => {
  beforeEach(() => {
    registerThenDegrade(reason);
  });

  it('refuses an anonymous caller, a member and the device key on either route without changing anything', async () => {
    // The Portal's answer wins over the role stored at sign-in when it gives one.
    portalSays('member');
    const before = snapshot();

    for (const from of [anonymousOnLan(), lanNamingLoopback(), signedIn('member'), signedIn('owner'), memoryWithDeviceKey()]) {
      await expect(sendPost(from)).rejects.toThrow(/Sign in as an owner or admin/);
      await expect(sendGet(from)).rejects.toThrow(/only accepted from this Hub itself/);
    }

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('is refused for a member whose role the Portal cannot confirm, without changing anything', async () => {
    portalRejectsDeviceKey();
    const before = snapshot();

    await expect(sendPost(signedIn('member'))).rejects.toThrow(/Sign in as an owner or admin/);
    // No role stored at all is not a yes either.
    await expect(sendPost(signedIn(null))).rejects.toThrow(ForbiddenException);

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('refuses a link opened in a browser on the Hub itself, on either route, without changing anything', async () => {
    const before = snapshot();
    // A link in a mail or chat app opens with `Sec-Fetch-Site: none`, from the same address the setup service uses.
    const linkOnThisHost = () => {
      const from = fromSetupService();
      from.headers['sec-fetch-site'] = 'none';
      return from;
    };

    await expect(sendGet(linkOnThisHost())).rejects.toThrow(/only accepted from this Hub itself/);
    await expect(sendPost(linkOnThisHost())).rejects.toThrow(/Sign in as an owner or admin/);

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('is refused on the POST when there is no request to read the caller from', async () => {
    await expect(controller.handleCallbackPost(BODY, service.mintCallbackNonce())).rejects.toThrow(/Sign in as an owner or admin/);
    expectNothingWritten();
  });

  it('completes on the POST for an owner the Portal confirms', async () => {
    portalSays('owner');

    await expect(sendPost(signedIn('member'))).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });

  it.each(['owner', 'admin'])('completes on the POST for a stored %s when the Portal will not say', async (role) => {
    portalRejectsDeviceKey();

    await expect(sendPost(signedIn(role))).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });

  it('completes on the POST from the setup service on the Hub itself, with no session', async () => {
    await expect(sendPost(fromSetupService())).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });

  it('completes on the GET from the setup service on the Hub itself, with no session', async () => {
    await expect(sendGet(fromSetupService())).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });
});

describe('a registration callback on a Hub that is not registered', () => {
  it('completes on the POST with its nonce, whoever sends it', async () => {
    await expect(sendPost(anonymousOnLan())).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(rows.map((row) => row.id)).toEqual(['org-current']));
    await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
    expect(portal.whoisApps).not.toHaveBeenCalled();
  });
});

/*
 * A Hub without its tunnel token reads `unregistered` in memory until boot restores the phase from
 * its row. It keeps reading it if that read fails. The row still says it is registered.
 */
describe('a registration callback on a Hub whose phase has not been restored from its row', () => {
  beforeEach(() => {
    rows.push({ id: 'org-current', slug: 'current', name: 'Current', hubSubdomain: 'current-sub', tunnelId: 'tun-current' });
    vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);
  });

  it('refuses an anonymous caller on the POST without changing anything', async () => {
    const before = snapshot();

    await expect(sendPost(anonymousOnLan())).rejects.toThrow(/Sign in as an owner or admin/);

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('completes on the POST from the setup service on the Hub itself', async () => {
    await expect(sendPost(fromSetupService())).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(rows[0]).toMatchObject({ tunnelToken: 'tok-new' }));
    expect(settings.ciHubApiKey).toBe('key-new');
    // The last write of the background setup, so none of it lands in the next test's rows.
    await vi.waitFor(() => expect(traefik.writeHubRoute).toHaveBeenCalled());
  });
});

/*
 * The same Hub while its database can't answer. Not knowing whether it holds a registration must not
 * read as "it holds none", or the callback would save a stranger's keys over this Hub's own.
 */
describe('a registration callback on a Hub whose registration cannot be read', () => {
  beforeEach(() => {
    settings.ciHubApiKey = 'key-current';
    const repository = (service as any).deviceRegistrationRepository as MockProxy<DeviceRegistrationRepository>;
    repository.getFirstDeviceRegistration.mockRejectedValue(new Error('connection terminated unexpectedly'));
    repository.hasAnyDeviceRegistration.mockRejectedValue(new Error('connection terminated unexpectedly'));
    vi.spyOn(service as any, 'hasTunnelToken').mockReturnValue(false);
  });

  it('refuses an anonymous caller on the POST and a pairing code from the LAN without changing anything', async () => {
    mockedPost.mockReset();
    const before = snapshot();

    await expect(sendPost(anonymousOnLan())).rejects.toThrow(/Sign in as an owner or admin/);
    await expect(sendPair(anonymousOnLan())).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('Sign in as an owner or admin'),
    });

    expect(portalPairCalls()).toEqual([]);
    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });
});

describe('a registration callback on a Hub that is registered and serving', () => {
  it('is refused for everyone, the owner and the setup service included', async () => {
    registerThenDegrade('portal_rejected');
    (service as any)._currentPhase = 'publicly_ready';
    (service as any)._degradedReasons = [];
    portalSays('owner');
    const before = snapshot();

    for (const from of [signedIn('owner'), fromSetupService(), anonymousOnLan()]) {
      await expect(sendPost(from)).rejects.toThrow(/Reset its registration from Settings/);
    }
    await expect(sendGet(fromSetupService())).rejects.toThrow(/Reset its registration from Settings/);

    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });
});

const asCli = () => request('192.168.1.50', '192.168.1.10:5002', { hubPrincipal: 'cli', user: { id: 1 } });
const asHostLocalKey = () => request('192.168.1.50', '192.168.1.10:5002', { hubPrincipal: 'host-local', user: { id: 1 } });
/** `cihub register` on the Hub's own machine, on a build that has no host-local key to send. */
const cliOnThisHostWithDeviceKey = () => request('172.18.0.1', '127.0.0.1:5002', { hubPrincipal: 'portal-device', user: { id: 1 } });

function portalIssuesPairing() {
  mockedPost.mockResolvedValue({ status: 200, headers: {}, data: { ...BODY, move_key: 'move-new' } } as any);
}

describe.each(['portal_rejected', 'tunnel_token_missing'] as const)('a pairing code on a %s Hub', (reason) => {
  beforeEach(() => {
    mockedPost.mockReset();
    registerThenDegrade(reason);
  });

  it('refuses an anonymous caller, a member and the device key before Portal is asked, without changing anything', async () => {
    portalSays('member');
    const before = snapshot();

    for (const from of [undefined, anonymousOnLan(), lanNamingLoopback(), signedIn('member'), signedIn('owner'), memoryWithDeviceKey()]) {
      await expect(sendPair(from)).resolves.toMatchObject({ success: false, message: expect.stringContaining('Sign in as an owner or admin') });
      await expect(sendPair(from, true)).resolves.toMatchObject({ success: false });
    }

    expect(portalPairCalls()).toEqual([]);
    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('refuses a member whose role the Portal cannot confirm and someone with no stored role', async () => {
    portalRejectsDeviceKey();

    await expect(sendPair(signedIn('member'))).resolves.toMatchObject({ success: false });
    await expect(sendPair(signedIn(null), true)).resolves.toMatchObject({ success: false });
    expect(portalPairCalls()).toEqual([]);
  });

  it('pairs for an owner the Portal confirms and passes their yes to a move on', async () => {
    portalSays('owner');
    portalIssuesPairing();

    await expect(sendPair(signedIn('member'), true)).resolves.toMatchObject({ success: true });
    expect(portalPairCalls()).toHaveLength(1);
    expect(portalPairCalls()[0]?.[1]).toMatchObject({ pairing_code: 'ABC123', device_key: 'key-current', confirm_move: true });
    await expectPairedAgain();
  });

  it.each(['owner', 'admin'])('pairs for a stored %s when the Portal will not say', async (role) => {
    portalRejectsDeviceKey();
    portalIssuesPairing();

    await expect(sendPair(signedIn(role))).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });

  it("refuses an owner's session that a page on another site or a sibling hostname sent, but not the Hub's own page", async () => {
    portalSays('owner');
    portalIssuesPairing();

    for (const fetchSite of ['same-site', 'cross-site']) {
      const fromOtherPage = signedIn('owner');
      fromOtherPage.headers['sec-fetch-site'] = fetchSite;
      await expect(sendPair(fromOtherPage)).resolves.toMatchObject({
        success: false,
        message: expect.stringContaining('Sign in as an owner or admin'),
      });
    }
    expect(portalPairCalls()).toEqual([]);
    expectNothingWritten();

    const fromHubPage = signedIn('owner');
    fromHubPage.headers['sec-fetch-site'] = 'same-origin';
    await expect(sendPair(fromHubPage)).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });

  it('pairs for the operator who claimed the Hub, whatever their role', async () => {
    users.getFirstOperator.mockResolvedValue({ id: OWNER_ID } as any);
    portalSays('member');
    portalIssuesPairing();

    await expect(sendPair(signedIn('member'))).resolves.toMatchObject({ success: true });
    await expectPairedAgain();
  });

  it.each([
    ['the CLI token', asCli],
    ['the host-local key', asHostLocalKey],
    ['a caller on the Hub itself', fromSetupService],
    ['cihub register on the Hub itself with only the device key', cliOnThisHostWithDeviceKey],
  ])('pairs for %s', async (_caller, from) => {
    portalIssuesPairing();

    await expect(sendPair(from())).resolves.toMatchObject({ success: true });
    expect(portal.whoisApps).not.toHaveBeenCalled();
    await expectPairedAgain();
  });
});

describe('a pairing code on a Hub that is not registered', () => {
  it('goes to Portal for anyone, as a first pairing has nobody to sign in as', async () => {
    mockedPost.mockReset();
    portalIssuesPairing();

    await expect(sendPair(anonymousOnLan())).resolves.toMatchObject({ success: true });
    expect(portalPairCalls()).toHaveLength(1);
    expect(portal.whoisApps).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((service as any)._currentPhase).toBe('publicly_ready'));
  });
});

describe('a pairing code on a Hub that is registered and serving', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    registerThenDegrade('portal_rejected');
    (service as any)._currentPhase = 'publicly_ready';
    (service as any)._degradedReasons = [];
  });

  it('is refused for everyone before Portal is asked, the owner and the Hub itself included', async () => {
    portalSays('owner');
    const before = snapshot();

    for (const from of [signedIn('owner'), asHostLocalKey(), fromSetupService(), anonymousOnLan()]) {
      await expect(sendPair(from)).resolves.toMatchObject({ success: false, message: 'Device is already registered.' });
    }

    expect(portalPairCalls()).toEqual([]);
    expect(snapshot()).toEqual(before);
    expectNothingWritten();
  });

  it('lets a caller who may pair it again through while Portal is rejecting its key but nobody else', async () => {
    (service as any).portalRejectedSince = Date.now();
    portalSays('member');

    await expect(sendPair(anonymousOnLan())).resolves.toMatchObject({ success: false, message: 'Device is already registered.' });
    await expect(sendPair(signedIn('owner'))).resolves.toMatchObject({ success: false, message: 'Device is already registered.' });
    expect(portalPairCalls()).toEqual([]);

    portalIssuesPairing();
    await expect(sendPair(asHostLocalKey())).resolves.toMatchObject({ success: true });
    expect(portalPairCalls()).toHaveLength(1);
    await vi.waitFor(() => expect(rows[0]).toMatchObject({ tunnelToken: 'tok-new' }));
    await vi.waitFor(() => expect(traefik.writeHubRoute).toHaveBeenCalled());
  });
});
