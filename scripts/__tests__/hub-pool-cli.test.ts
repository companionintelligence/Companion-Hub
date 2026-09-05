import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DiscoverablePoolPeer,
  type PoolPeerRow,
  type PoolRoutingLogResponse,
  type PoolStatusResponse,
  formatPoolDiscoverLines,
  formatPoolPeerTable,
  formatPoolPeersLines,
  formatPoolRoutingLogLines,
  formatPoolStatusLines,
  formatPoolTimestamp,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setPoolEnabledSetting,
  unpairPoolPeer,
} from '../hub-pool-cli';

const hubApiFetch = vi.fn();

vi.mock('../public-web-cli', () => ({
  hubApiFetch: (...args: unknown[]) => hubApiFetch(...args),
}));

// Placeholder tailnet names only — docs/README.md tip-scrub policy.
const PEER_A = 'hub-b.example-tailnet.ts.net';
const PEER_B = 'hub-c.example-tailnet.ts.net';

function peer(overrides: Partial<PoolPeerRow> = {}): PoolPeerRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    nodeFqdn: PEER_A,
    displayName: null,
    direction: 'outbound',
    status: 'connected',
    consecutiveFailures: 0,
    lastSeenAt: '2026-09-05T10:00:01.000Z',
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3', 'qwen3'] }] },
    inFlightRequests: 2,
    ...overrides,
  };
}

function status(overrides: Partial<PoolStatusResponse> = {}): PoolStatusResponse {
  return {
    enabled: true,
    disabledBy: null,
    reason: 'active',
    routingActive: true,
    settings: { poolEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
    tailscaleAdminApiConfigured: true,
    localNode: {
      nodeFqdn: 'hub-a.example-tailnet.ts.net',
      tailnet: 'example-tailnet.ts.net',
      tailscaleConnected: true,
      inFlightRequests: 0,
      hardwareTier: 'high',
      backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['llama3'] }],
      capabilitiesError: null,
    },
    peers: [peer()],
    peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    routing: { recorded: 3, capacity: 200, served: 2, failed: 1, failovers: 1, lastAt: '2026-09-05T10:00:01.000Z' },
    ...overrides,
  };
}

describe('hub-pool-cli formatters', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('renders an active pool with the local node, counts, settings and peer table', () => {
    const lines = formatPoolStatusLines(status());
    const text = lines.join('\n');

    expect(text).toContain('Pooling      ✓ active');
    expect(text).toContain('1 total · 1 connected · 0 pending · 0 unreachable');
    expect(text).toContain('poolEnabled=true · localAffinity=1 · healthPoll=30s');
    expect(text).toContain('hub-a.example-tailnet.ts.net');
    expect(text).toContain('tailnet example-tailnet.ts.net');
    expect(text).toContain('ollama ✓ 1');
    // Peer row: status, last seen, queue depth and engines all present.
    expect(text).toContain('hub-b.example-tailnet.ts.net');
    expect(text).toContain('2026-09-05 10:00:01Z');
    expect(text).toContain('ollama ✓ 2');
  });

  it('names the env override rather than reporting a plain "off"', () => {
    const text = formatPoolStatusLines(status({ enabled: false, disabledBy: 'env', reason: 'disabled_by_env', routingActive: false })).join('\n');
    expect(text).toContain('HUB_POOL_USER_DISABLED=true');
    expect(text).toContain('the .env wins over the setting');
  });

  it('separates "enabled but no peers" from "disabled"', () => {
    const text = formatPoolStatusLines(
      status({ reason: 'no_peers', routingActive: false, peers: [], peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0 } }),
    ).join('\n');
    expect(text).toContain('enabled, not routing');
    expect(text).toContain('No paired peers');
  });

  it('says why the local inventory is empty when a backend is down', () => {
    const text = formatPoolStatusLines(status({ localNode: { ...status().localNode, backends: [], capabilitiesError: 'ollama unreachable' } })).join(
      '\n',
    );
    expect(text).toContain('✗ ollama unreachable');
  });

  it('shows the strike count next to a failing peer status', () => {
    const text = formatPoolPeerTable([peer({ status: 'unreachable', consecutiveFailures: 2 })]).join('\n');
    expect(text).toContain('unreachable 2/3');
  });

  it('surfaces the approve/reject hint only when an inbound request is pending', () => {
    const pending = formatPoolPeersLines([peer({ direction: 'inbound', status: 'pending', lastCapabilities: null })]).join('\n');
    expect(pending).toContain('cihub pool approve <id>');
    expect(formatPoolPeersLines([peer()]).join('\n')).not.toContain('cihub pool approve <id>');
  });

  it('lists each peer’s models under the table', () => {
    const text = formatPoolPeersLines([peer()]).join('\n');
    expect(text).toContain('ollama: llama3, qwen3');
  });

  it('strips control characters from server-supplied values', () => {
    const esc = String.fromCharCode(27);
    const text = formatPoolPeerTable([peer({ nodeFqdn: `hub-${esc}[2Jx.example-tailnet.ts.net` })]).join('\n');
    expect(text).not.toContain(esc);
  });

  it('formats timestamps and tolerates a non-ISO value', () => {
    expect(formatPoolTimestamp('2026-09-05T10:00:01.000Z')).toBe('2026-09-05 10:00:01Z');
    expect(formatPoolTimestamp(null)).toBe('-');
    expect(formatPoolTimestamp('not a date')).toBe('not a date');
  });

  it('renders the failover chain, not just a count', () => {
    const log: PoolRoutingLogResponse = {
      entries: [
        {
          at: '2026-09-05T10:00:01.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'llama3',
          node: PEER_A,
          peerId: 'p1',
          backend: 'ollama',
          candidates: 3,
          attempt: 2,
          failedOverFrom: ['local'],
          outcome: 'served',
          status: 200,
          durationMs: 1204,
        },
      ],
      summary: { recorded: 1, capacity: 200, served: 1, failed: 0, failovers: 1, lastAt: '2026-09-05T10:00:01.000Z' },
    };
    const text = formatPoolRoutingLogLines(log).join('\n');
    expect(text).toContain('↳ failed over from local');
    expect(text).toContain('2/3');
    expect(text).toContain('✓ served 200');
    // Column widths must not eat the timestamp or the peer name — both identify the decision.
    expect(text).toContain('2026-09-05 10:00:01Z');
    expect(text).toContain(PEER_A);
  });

  it('explains an empty routing log rather than showing an empty table', () => {
    const text = formatPoolRoutingLogLines({
      entries: [],
      summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null },
    }).join('\n');
    expect(text).toContain('Nothing routed since the Hub started.');
    expect(text).toContain('in-memory and process-local');
  });

  it('resolves a peer by id prefix or FQDN and refuses an ambiguous prefix', () => {
    const peers = [peer(), peer({ id: '11111111-9999-0000-0000-000000000000', nodeFqdn: PEER_B })];
    expect(resolvePoolPeerTarget(peers, PEER_B)).toEqual({ peer: peers[1] });
    expect(resolvePoolPeerTarget(peers, '11111111-2222-3333-4444-555555555555')).toEqual({ peer: peers[0] });
    expect(resolvePoolPeerTarget(peers, '11111111')).toEqual({ error: expect.stringContaining('matches 2 peers') });
    expect(resolvePoolPeerTarget(peers, 'nope')).toEqual({ error: expect.stringContaining('No paired peer matching') });
  });
});

describe('hub-pool-cli discovery', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('explains the missing Tailscale Admin API credential and never calls the discovery route', async () => {
    hubApiFetch.mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false }));

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(false);
    expect(hubApiFetch).toHaveBeenCalledTimes(1);
    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/status');
    const text = result.lines.join('\n');
    expect(text).toContain('Peer discovery is not configured');
    expect(text).toContain('TAILSCALE_OAUTH_CLIENT_ID');
    expect(text).toContain('can still be');
    expect(text).not.toContain('No unpaired CI-Hub nodes');
  });

  it('distinguishes a configured-but-empty tailnet from the unconfigured case', async () => {
    hubApiFetch.mockResolvedValueOnce(status()).mockResolvedValueOnce([]);

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(true);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/peers/discoverable');
    expect(result.lines.join('\n')).toContain('No unpaired CI-Hub nodes found on this tailnet.');
  });

  it('lists discoverable devices with the pair hint', () => {
    const devices: DiscoverablePoolPeer[] = [{ tailscaleDeviceId: 'dev-1', nodeFqdn: PEER_A, hostname: 'hub-b' }];
    const text = formatPoolDiscoverLines(devices, true).join('\n');
    expect(text).toContain(PEER_A);
    expect(text).toContain('cihub pool pair <node>');
  });
});

describe('hub-pool-cli requests', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('bounds every call with an AbortSignal, since hubApiFetch supplies none', async () => {
    hubApiFetch.mockResolvedValue({});

    await unpairPoolPeer('.env.local', 'peer-1');
    await setPoolEnabledSetting('.env.local', false);

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/peer-1');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBe('DELETE');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/settings');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).body).toBe('{"poolEnabled":false}');
  });

  it('encodes the peer id into the path', async () => {
    hubApiFetch.mockResolvedValue({});
    await unpairPoolPeer('.env.local', 'a/b');
    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/a%2Fb');
  });
});
