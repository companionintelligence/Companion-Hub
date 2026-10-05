import type { DiscoverablePoolPeer, PoolPeer, PoolStatus } from '@/modules/settings/helpers/hub-pool-shared';
import type { TailscaleSetupStatus } from '@/modules/settings/components/pool-setup-wizard/pool-setup-model';

/*
 * Builders for the Hub Pool guide's suites. Hostnames use the documentation-style `example-tailnet.ts.net`
 * suffix: nothing here is, or may become, a real tailnet name.
 */

export const LOCAL_FQDN = 'hub-a.example-tailnet.ts.net';

/** A pool with no peers on a Hub that is on, with Tailscale connected: the state the Home invite is for. */
export const poolStatus = (overrides: Partial<PoolStatus> = {}): PoolStatus => ({
  enabled: true,
  disabledBy: null,
  directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
  reason: 'no_peers',
  routingActive: false,
  settings: {
    poolEnabled: true,
    poolOutboundEnabled: true,
    poolInboundEnabled: true,
    poolLocalAffinity: 1,
    poolHealthPollSeconds: 30,
    poolRequireSignedPeers: false,
  },
  tailscaleAdminApiConfigured: false,
  localNode: {
    nodeFqdn: LOCAL_FQDN,
    tailnet: 'example-tailnet.ts.net',
    tailscaleConnected: true,
    inFlightRequests: 0,
    hardwareTier: 'workstation',
    backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3.2:3b'] }],
    capabilitiesError: null,
    identity: { nodeUuid: 'self-uuid', publicKeyFingerprint: '11:22:33:44:55:66:77:88', identityError: null },
  },
  peers: [],
  peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
  routing: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null },
  ...overrides,
});

/** A pool holding these peers, with `peerCounts` derived so a fixture cannot disagree with itself. */
export const poolWith = (peers: PoolPeer[], overrides: Partial<PoolStatus> = {}): PoolStatus =>
  poolStatus({
    peers,
    peerCounts: {
      total: peers.length,
      connected: peers.filter((peer) => peer.status === 'connected').length,
      pending: peers.filter((peer) => peer.status === 'pending').length,
      unreachable: peers.filter((peer) => peer.status === 'unreachable').length,
      disabled: peers.filter((peer) => !peer.enabled).length,
    },
    ...overrides,
  });

/** A connected peer whose models have been read. */
export const poolPeer = (overrides: Partial<PoolPeer> = {}): PoolPeer => ({
  id: 'peer-1',
  nodeFqdn: 'hub-b.example-tailnet.ts.net',
  displayName: 'hub-b',
  direction: 'outbound',
  status: 'connected',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: '2026-10-01T10:00:00.000Z',
  lastCapabilities: {
    hardwareTier: 'server',
    backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3.2:3b', 'qwen3:8b'] }],
    updatedAt: '2026-10-01T10:00:00.000Z',
  },
  inFlightRequests: 0,
  ...overrides,
});

/** A request this Hub sent that the other Hub has not approved. */
export const waitingPeer = (overrides: Partial<PoolPeer> = {}): PoolPeer =>
  poolPeer({ id: 'peer-wait', status: 'pending', direction: 'outbound', lastSeenAt: null, lastCapabilities: null, ...overrides });

/** A request another Hub sent to this one. */
export const incomingPeer = (overrides: Partial<PoolPeer> = {}): PoolPeer =>
  poolPeer({
    id: 'peer-in',
    nodeFqdn: 'hub-c.example-tailnet.ts.net',
    displayName: 'Loft Hub',
    status: 'pending',
    direction: 'inbound',
    lastSeenAt: null,
    lastCapabilities: null,
    ...overrides,
  });

export const tailscaleStatus = (overrides: Partial<TailscaleSetupStatus> = {}): TailscaleSetupStatus => ({
  installed: true,
  connected: true,
  nodeFqdn: LOCAL_FQDN,
  hostname: 'hub-a',
  httpsAvailable: true,
  servePermission: { denied: false },
  peers: [],
  ...overrides,
});

export const candidate = (hostname: string, overrides: Partial<DiscoverablePoolPeer> = {}): DiscoverablePoolPeer => ({
  tailscaleDeviceId: `device-${hostname}`,
  nodeFqdn: `${hostname}.example-tailnet.ts.net`,
  hostname,
  ...overrides,
});
