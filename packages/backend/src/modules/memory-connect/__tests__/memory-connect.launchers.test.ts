import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryConnectService } from '../memory-connect.service';

/**
 * Regression cover for CI-Engineering#75: the launcher contract.
 *
 * The bug class these lock down is "the Hub hands out a URL it cannot keep" —
 * a launcher pointing at a dead public origin, or at a LAN address the caller
 * cannot route to. The two status endpoints deliberately fail in OPPOSITE
 * directions, so each is asserted separately.
 */
const PUBLIC_HOST = 'hub-core2-acme.companionintelligence.com';
const LAN_HOST = '192.168.1.9';
const APP = 'ci-openclaw:ci-marketplace';

const PUBLIC_LAUNCHER = `https://${PUBLIC_HOST}/api/memory-connect/start?app=ci-openclaw%3Aci-marketplace`;
const LOCAL_LAUNCHER = `http://${LAN_HOST}/api/memory-connect/start?app=ci-openclaw%3Aci-marketplace`;

function makeService(
  options: { tunnelHealth?: string; providerLocalOnly?: boolean; providerStatus?: string; internalIp?: string; hubSubdomain?: string } = {},
) {
  const resolver = {
    findProvider: vi.fn(),
    getProviderRuntimeInfo: vi.fn().mockResolvedValue({
      status: options.providerStatus ?? 'ready',
      localOnly: options.providerLocalOnly ?? false,
    }),
    getProviderRuntimeStatus: vi.fn().mockResolvedValue(options.providerStatus ?? 'ready'),
    getAppPublicUrl: vi.fn().mockResolvedValue('https://app.example.org'),
    getAppAccessUrls: vi.fn().mockResolvedValue({ publicUrl: 'https://app.example.org', localUrl: 'http://192.168.1.9:8080' }),
    isConsumerApp: vi.fn().mockResolvedValue(true),
    getAppName: vi.fn().mockResolvedValue('OpenClaw'),
  };
  const connections = {
    getState: vi.fn().mockResolvedValue('unconfigured'),
    getRow: vi.fn().mockResolvedValue({ state: 'unconfigured', keyExpiresAt: null }),
    credsFromRow: vi.fn().mockReturnValue(null),
  };
  const deviceRegistration = {
    getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: options.hubSubdomain ?? 'hub-core2-acme' }),
  };
  const config = {
    getConfig: vi.fn().mockReturnValue({
      domain: 'companionintelligence.com',
      localDomain: 'ci.lan',
      userSettings: { internalIp: options.internalIp ?? LAN_HOST, port: 80 },
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tunnelHealth = { getHealth: vi.fn().mockReturnValue(options.tunnelHealth ?? 'up'), invalidate: vi.fn() };

  const service = new MemoryConnectService(
    resolver as never,
    {} as never,
    connections as never,
    { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn(), recordOutcome: vi.fn() } as never,
    deviceRegistration as never,
    config as never,
    logger as never,
    { getAppByUrn: vi.fn().mockResolvedValue({ status: 'running' }) } as never,
    tunnelHealth as never,
    { get: vi.fn() } as never,
  );

  return { service, resolver, logger, tunnelHealth, connections };
}

beforeEach(() => vi.clearAllMocks());

describe('launcher selection — healthy public route', () => {
  it('offers the public launcher to a remote caller', async () => {
    const { service } = makeService();

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    expect(status.connectUrl).toBe(PUBLIC_LAUNCHER);
    expect(status.connectable).toBe(true);
    expect(status.reason).toBeNull();
  });

  it('keeps the public launcher as the default for a LAN caller, but advertises the local one too', async () => {
    const { service } = makeService();

    const status = await service.getStatus(APP, { host: LAN_HOST });

    // "Fallback only": a working public route stays the default even on the LAN,
    // so today's behaviour is unchanged for every healthy install.
    expect(status.connectUrl).toBe(PUBLIC_LAUNCHER);
    expect(status.connectUrlLocal).toBe(LOCAL_LAUNCHER);
  });

  it('withholds the local launcher from a remote caller who could not route to it', async () => {
    const { service } = makeService();

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    expect(status.connectUrlLocal).toBeNull();
  });

  it('treats an unknown (cold) tunnel reading as usable rather than suppressing', async () => {
    const { service } = makeService({ tunnelHealth: 'unknown' });

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    // A Hub that has not finished its first probe must behave exactly as before.
    expect(status.connectUrl).toBe(PUBLIC_LAUNCHER);
    expect(status.connectable).toBe(true);
  });
});

describe('launcher selection — public route down', () => {
  it('falls back to the LAN launcher for a caller on the local network', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectUrl).toBeNull();
    expect(status.connectUrlLocal).toBe(LOCAL_LAUNCHER);
    expect(status.connectable).toBe(true);
  });

  it('reports hub_unreachable to a remote caller instead of a dead public launcher', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    // The whole point of #75: never hand out a URL that lands on a Cloudflare
    // error page with no way back.
    expect(status.connectUrl).toBeNull();
    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_unreachable');
  });

  it('reports hub_not_provisioned when there is no public origin at all', async () => {
    const { service } = makeService({ tunnelHealth: 'disabled', hubSubdomain: '' });
    // An unregistered appliance reached from somewhere non-local.
    const status = await service.getStatus(APP, { host: 'someone.example.com' });

    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_not_provisioned');
  });

  it('still serves a LAN caller on an unregistered appliance', async () => {
    const { service } = makeService({ tunnelHealth: 'disabled', hubSubdomain: '' });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectUrlLocal).toBe(LOCAL_LAUNCHER);
    expect(status.connectable).toBe(true);
  });
});

describe('caller locality — the tunnel rewrites Host to the local domain', () => {
  // buildOriginServerName makes the Cloudflare tunnel send `<app>.ci.lan` to
  // Traefik, so a REMOTE visitor reaches the app carrying a private-looking host.
  // Trusting it would hand them an unroutable 192.168.x.x launcher.
  const TUNNELLED_HOST = 'openclaw-hub-core2-acme.ci.lan';

  it('does not treat a local-domain host as local, because a remote visitor arrives with one', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: TUNNELLED_HOST });

    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_unreachable');
  });

  it('does not advertise the LAN launcher to a local-domain caller even when the tunnel is healthy', async () => {
    const { service } = makeService();

    const status = await service.getStatus(APP, { host: TUNNELLED_HOST });

    expect(status.connectUrl).toBe(PUBLIC_LAUNCHER);
    expect(status.connectUrlLocal).toBeNull();
  });

  it('does NOT block a local-domain caller from a LAN-only ci-memory', async () => {
    // The mirror image of the two cases above, and the reason locality is
    // tri-state. `.ci.lan` means "cannot tell", and the two decisions keyed off
    // it fail in opposite directions: withholding the LAN launcher costs a remote
    // visitor nothing, but blocking here would refuse the connect to every LAN
    // user of a local-only appliance — the one deployment where a LAN-only
    // ci-memory is the normal configuration.
    const { service } = makeService({ providerLocalOnly: true });

    const status = await service.getStatus(APP, { host: TUNNELLED_HOST });

    expect(status.connectable).toBe(true);
    expect(status.connectUrl).toBe(PUBLIC_LAUNCHER);
    expect(status.reason).toBeNull();
  });

  it('still blocks a CONFIRMED remote caller from a LAN-only ci-memory', async () => {
    const { service } = makeService({ providerLocalOnly: true });

    const status = await service.getStatus(APP, { host: 'hub-core2-acme.companionintelligence.com' });

    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('provider_local_only');
  });

  it('still trusts a private IP literal — nothing rewrites a Host into one', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: `${LAN_HOST}:8080` });

    expect(status.connectUrlLocal).toBe(LOCAL_LAUNCHER);
    expect(status.connectable).toBe(true);
  });
});

describe('launcher selection — loopback guard', () => {
  it('withholds a loopback LAN launcher from a caller who reached us on a real LAN address', async () => {
    // INTERNAL_IP unset/listen-all collapses the local origin to 127.0.0.1. On a
    // visitor's own machine that points at THEIR computer, so offering it would
    // swap one dead link for another.
    const { service } = makeService({ tunnelHealth: 'down', internalIp: '0.0.0.0' });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_unreachable');
  });

  it('still offers a loopback launcher to a loopback caller, where it is correct', async () => {
    const { service } = makeService({ tunnelHealth: 'down', internalIp: '0.0.0.0' });

    const status = await service.getStatus(APP, { host: 'localhost:8080' });

    expect(status.connectUrlLocal).toBe('http://127.0.0.1/api/memory-connect/start?app=ci-openclaw%3Aci-marketplace');
    expect(status.connectable).toBe(true);
  });

  it('catches an IPv6 loopback origin too, which URL.hostname reports bracketed', async () => {
    // `new URL('http://[::1]').hostname` is '[::1]', never '::1'. Comparing the
    // raw value silently defeats this guard for every IPv6 appliance.
    const { service } = makeService({ tunnelHealth: 'down', internalIp: '::1' });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
  });
});

describe('caller Host hardening — the Host is attacker-controlled', () => {
  it('does not classify a userinfo-spoofed Host as local', async () => {
    // `new URL('http://evil.com@192.168.1.9').hostname` is 192.168.1.9. Trusting
    // that would let a remote caller forge a private host, bypass the remote
    // block, and be handed (or told) the appliance's LAN launcher.
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: 'evil.com@192.168.1.9' });

    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_unreachable');
  });

  it('does not crash when a repeated query key makes the Host an array', async () => {
    // Express yields string[] for `?clientHost=a&clientHost=b`; hostnameOf must
    // reject it rather than throw an uncaught TypeError and 500 the /state poll.
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: ['192.168.1.9', 'evil.com'] as unknown as string });

    expect(status.connectable).toBe(false);
    expect(status.connectUrlLocal).toBeNull();
  });
});

describe('launcher selection — provider reachability (Problem 2)', () => {
  it('blocks a remote caller when ci-memory is exposed on the LAN only', async () => {
    const { service, logger } = makeService({ providerLocalOnly: true });

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    // No Hub launcher can rescue this caller — the consent hop itself lands on a
    // private address, which used to just hang on an unroutable IP.
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('provider_local_only');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('local network only'));
  });

  it('allows a LAN caller to connect to a LAN-only ci-memory', async () => {
    const { service } = makeService({ providerLocalOnly: true });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectable).toBe(true);
  });
});

describe('launcher selection — provider lifecycle', () => {
  it.each([
    ['absent', 'memory_absent'],
    ['starting', 'memory_starting'],
    ['offline', 'memory_offline'],
  ])('reports %s as %s with no launcher', async (providerStatus, reason) => {
    const { service } = makeService({ providerStatus });

    const status = await service.getStatus(APP, { host: LAN_HOST });

    expect(status.connectUrl).toBeNull();
    expect(status.connectUrlLocal).toBeNull();
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe(reason);
  });
});

describe('opposite fail directions for the two endpoints', () => {
  it('/state hands the wrapper null URLs so a blocking gate stands down', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getStatus(APP, { host: PUBLIC_HOST });

    expect(status.connectUrl).toBeNull();
    expect(status.connectUrlLocal).toBeNull();
  });

  it('/status still reports applicable + a reason so the Hub button can explain itself', async () => {
    const { service } = makeService({ tunnelHealth: 'down' });

    const status = await service.getUiStatus(APP, { host: PUBLIC_HOST });

    // Non-blocking surface: keep showing the action, disabled, with a reason —
    // rather than hiding it and making the feature look absent.
    expect(status.applicable).toBe(true);
    expect(status.memoryReady).toBe(true);
    expect(status.connectable).toBe(false);
    expect(status.reason).toBe('hub_unreachable');
  });
});

describe('flow origin', () => {
  it('runs the ceremony on the LAN origin when the user started there', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://memory.example.org',
    });

    const consentUrl = new URL(await service.startConnect(APP as never, undefined, 'user-1', { host: LAN_HOST }));

    // The callback must come back to the origin the user is actually on: their
    // Hub session cookie does not exist on the public origin.
    expect(consentUrl.searchParams.get('return')).toBe(`http://${LAN_HOST}/api/memory-connect/callback`);
  });

  it('falls back to the public origin for an unrecognised Host rather than echoing it', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://memory.example.org',
    });

    const consentUrl = new URL(await service.startConnect(APP as never, undefined, 'user-1', { host: 'attacker.example.com' }));

    // Echoing an unvalidated Host into a redirect target would be an open redirect.
    expect(consentUrl.searchParams.get('return')).toBe(`https://${PUBLIC_HOST}/api/memory-connect/callback`);
  });
});

describe('post-connect landing allowlist (Problem 5)', () => {
  it('preserves a LAN `next` instead of relocating the user to the public origin', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://memory.example.org',
    });
    const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn(), recordOutcome: vi.fn() };
    // Re-wire the pending store so the stored `next` can be asserted.
    (service as unknown as { pending: typeof pending }).pending = pending;

    await service.startConnect(APP as never, 'http://192.168.1.9:8080/settings', 'user-1', { host: LAN_HOST });

    expect(pending.create).toHaveBeenCalledWith(APP, 'http://192.168.1.9:8080/settings', 'user-1');
  });

  it('still rejects an off-origin `next`', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://memory.example.org',
    });
    const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn(), recordOutcome: vi.fn() };
    (service as unknown as { pending: typeof pending }).pending = pending;

    await service.startConnect(APP as never, 'https://evil.example.com/phish', 'user-1', { host: LAN_HOST });

    expect(pending.create).toHaveBeenCalledWith(APP, 'https://app.example.org', 'user-1');
  });
});

describe('post-connect landing — the LAN fallback is gated on caller locality', () => {
  const downPrimary = { publicUrl: 'https://app.example.org', localUrl: 'http://192.168.1.9:8080', primaryAvailable: false };

  function withProvider() {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://memory.example.org',
    });
    resolver.getAppAccessUrls.mockResolvedValue(downPrimary);
    const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn(), recordOutcome: vi.fn() };
    (service as unknown as { pending: typeof pending }).pending = pending;
    return { service, pending };
  }

  it('lands a LOCAL caller on the app LAN address when the public route is down', async () => {
    const { service, pending } = withProvider();

    await service.startConnect(APP as never, undefined, 'user-1', { host: LAN_HOST });

    expect(pending.create).toHaveBeenCalledWith(APP, 'http://192.168.1.9:8080', 'user-1');
  });

  it('lands a REMOTE caller on the public URL even when it is down — the LAN address is dead to them', async () => {
    // Without the locality gate, a remote desktop user connecting while the app's
    // DNS is merely propagating would be redirected to an unroutable 192.168.x
    // address post-connect and stranded.
    const { service, pending } = withProvider();

    await service.startConnect(APP as never, undefined, 'user-1', { host: PUBLIC_HOST });

    expect(pending.create).toHaveBeenCalledWith(APP, 'https://app.example.org', 'user-1');
  });
});
