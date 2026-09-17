import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DiscoverablePoolPeer,
  type PoolPeerRow,
  type PoolProbeResult,
  type PoolRoutingLogResponse,
  type PoolStatusResponse,
  cancelPairingPin,
  formatPairingPinCancelledLines,
  formatPairingPinLines,
  formatPairingPinStateLines,
  formatPeerAuthModeLines,
  formatPeerRefusalLines,
  formatPoolDiscoverLines,
  formatPoolPeerTable,
  formatPoolPeersLines,
  formatPoolProbeLines,
  formatPoolRoutingLogLines,
  formatPoolPinLines,
  formatPoolStatusLines,
  formatPoolTimestamp,
  deletePoolPin,
  setPoolPin,
  probePoolAddress,
  mintPairingPin,
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
    enabled: true,
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
    directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
    reason: 'active',
    routingActive: true,
    settings: { poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
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
    peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
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
    expect(text).toContain('1 total · 1 connected · 0 pending · 0 unreachable · 0 disabled');
    expect(text).toContain('poolEnabled=true · outbound=true · inbound=true · localAffinity=1 · healthPoll=30s');
    expect(text).toContain('hub-a.example-tailnet.ts.net');
    expect(text).toContain('tailnet example-tailnet.ts.net');
    expect(text).toContain('ollama ✓ 1');
    // Peer row: status, last seen, queue depth and engines all present.
    expect(text).toContain('hub-b.example-tailnet.ts.net');
    expect(text).toContain('2026-09-05 10:00:01Z');
    expect(text).toContain('ollama ✓ 2');
  });

  it('renders each direction and names the switch actually holding it off', () => {
    const text = formatPoolStatusLines(
      status({
        reason: 'partially_disabled',
        routingActive: false,
        directions: { outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: false, disabledBy: 'env' } },
        settings: { poolEnabled: true, poolOutboundEnabled: false, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      }),
    ).join('\n');

    expect(text).toContain('partly disabled');
    // Each line points at the thing that actually has to change, per direction.
    expect(text).toContain('cihub pool enable --outbound');
    expect(text).toContain('HUB_POOL_INBOUND_DISABLED=true');
    expect(text).toContain('poolEnabled=true · outbound=false · inbound=true');
  });

  it('marks a disabled peer instead of printing "connected" for a node that exchanges no work', () => {
    const text = formatPoolStatusLines(
      status({ peers: [peer({ enabled: false })], peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 1 } }),
    ).join('\n');

    expect(text).toContain('connected/off');
    expect(text).toContain('1 disabled');
  });

  it('names the env override rather than reporting a plain "off"', () => {
    const text = formatPoolStatusLines(status({ enabled: false, disabledBy: 'env', reason: 'disabled_by_env', routingActive: false })).join('\n');
    expect(text).toContain('HUB_POOL_USER_DISABLED=true');
    expect(text).toContain('the .env wins over the setting');
  });

  it('separates "enabled but no peers" from "disabled"', () => {
    const text = formatPoolStatusLines(
      status({
        reason: 'no_peers',
        routingActive: false,
        peers: [],
        peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
      }),
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

  it('still asks for the candidate list with no Admin API credential, because two sources need none', async () => {
    // Deliberately changed: this used to short-circuit on `tailscaleAdminApiConfigured: false`,
    // back when that credential was the only source of candidates. The local Tailscale daemon's
    // peer map and the CI Portal device registry both name candidates without it, so
    // short-circuiting hid real candidates on exactly the Hubs that have no credential.
    hubApiFetch.mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false })).mockResolvedValueOnce([]);

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(false);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/peers/discoverable');
  });

  it('offers manual entry first and the OAuth credential second when nothing is found', async () => {
    hubApiFetch.mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false })).mockResolvedValueOnce([]);

    const text = (await runPoolDiscover('.env.local')).lines.join('\n');

    expect(text).toContain('cihub pool probe <address>');
    expect(text).toContain('TAILSCALE_OAUTH_CLIENT_ID');
    // The credential stays genuinely optional, and the copy has to keep saying so.
    expect(text).toContain('pools normally without it');
  });

  it('distinguishes a configured-but-empty tailnet from the unconfigured case', async () => {
    hubApiFetch.mockResolvedValueOnce(status()).mockResolvedValueOnce([]);

    const result = await runPoolDiscover('.env.local');

    expect(result.configured).toBe(true);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/peers/discoverable');
    expect(result.lines.join('\n')).toContain('Whole-tailnet enumeration is configured, and found nothing unpaired.');
  });

  it('reports `found` from the candidate list, not from the Admin API credential', async () => {
    // `found` is what colours the box, and yellow means a problem state in this CLI. A Hub with no
    // credential that listed candidates from its daemon peer map or from Portal has no problem.
    hubApiFetch
      .mockResolvedValueOnce(status({ tailscaleAdminApiConfigured: false }))
      .mockResolvedValueOnce([{ tailscaleDeviceId: '', nodeFqdn: PEER_A, hostname: 'hub-b' }]);

    const result = await runPoolDiscover('.env.local');

    expect(result).toMatchObject({ configured: false, found: true });
  });

  it('lists discoverable devices with the pair hint', () => {
    const devices: DiscoverablePoolPeer[] = [{ tailscaleDeviceId: 'dev-1', nodeFqdn: PEER_A, hostname: 'hub-b' }];
    const text = formatPoolDiscoverLines(devices, true).join('\n');
    expect(text).toContain(PEER_A);
    expect(text).toContain('cihub pool pair <node>');
  });

  it('points at pairing by address when the tailnet list is empty', () => {
    const text = formatPoolDiscoverLines([], false).join('\n');

    // A Hub found by address is never in this list — an address is not a name — so the empty state
    // has to say how it IS paired with, PIN and all.
    expect(text).toContain('cihub pool probe <address>');
    expect(text).toContain('--pin');
  });

  it('renders an off-box hostname through sanitizeForBox', () => {
    // Box output is ANSI-injectable, and every string on a candidate row is authored off-box.
    const devices: DiscoverablePoolPeer[] = [{ tailscaleDeviceId: '', nodeFqdn: PEER_A, hostname: '[31mred[0m' }];

    expect(formatPoolDiscoverLines(devices, false).join('\n')).not.toContain('[31m');
  });
});

describe('hub-pool-cli probe', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  function probeResult(overrides: Partial<PoolProbeResult> = {}): PoolProbeResult {
    return {
      address: '192.168.1.42',
      isCiHub: true,
      poolProtocol: 2,
      pairable: true,
      reason: null,
      ...overrides,
    };
  }

  it('posts the address the operator typed, unmodified', async () => {
    hubApiFetch.mockResolvedValueOnce(probeResult());

    await probePoolAddress('.env.local', '192.168.1.42:5010');

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/peers/probe');
    expect(JSON.parse((hubApiFetch.mock.calls[0]?.[2] as RequestInit).body as string)).toEqual({ address: '192.168.1.42:5010' });
  });

  it('says the node was found but NOT named, and routes the operator through the PIN', () => {
    const text = formatPoolProbeLines(probeResult()).join('\n');

    // The one thing about this feature that would be easy and costly to misunderstand: the probe
    // cannot name the node, so the output must not read as if it had.
    expect(text).not.toContain(PEER_A);
    expect(text).toContain('cihub pool pairing-pin');
    expect(text).toContain('cihub pool pair 192.168.1.42 --pin');
    expect(text).toContain('reach the handshake');
  });

  it('names the port fix when nothing answered', () => {
    const text = formatPoolProbeLines(probeResult({ isCiHub: false, poolProtocol: null, pairable: false, reason: 'unreachable' })).join('\n');

    expect(text).toContain('cihub pool probe <address>:<port>');
  });

  it('tells an old-protocol Hub apart from one that is simply absent, and names the way round it', () => {
    // It cannot answer a PIN with its name, so pairing by address is impossible against it — but
    // pairing by MagicDNS name still works, and that is the actionable half.
    const text = formatPoolProbeLines(probeResult({ poolProtocol: null, pairable: false, reason: 'protocol_too_old' })).join('\n');

    expect(text).toContain('older pool protocol');
    expect(text).toContain('cihub pool pair <node-fqdn>');
  });

  it('never claims to know the node’s name, on any branch', () => {
    // The regression guard for this whole feature: the probe result carries no name, so no branch
    // of the operator output may imply one.
    for (const reason of ['unreachable', 'not_a_hub', 'protocol_too_old', null] as const) {
      const text = formatPoolProbeLines(probeResult({ reason, pairable: reason === null })).join('\n');
      expect(text).not.toContain(PEER_A);
    }
  });

  it('sanitizes the address it echoes back', () => {
    const text = formatPoolProbeLines(probeResult({ address: '[31m192.168.1.42[0m' })).join('\n');

    expect(text).not.toContain('[31m');
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

describe('hub-pool-cli pins', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('prints nothing at all when no pin is set, and on a Hub that predates pinning', () => {
    expect(formatPoolPinLines([])).toEqual([]);
    expect(formatPoolPinLines(undefined)).toEqual([]);
  });

  it('names each pin, its target, and says which are not doing anything', () => {
    const text = formatPoolPinLines([
      { scope: 'default', targetKind: 'local', mode: 'prefer', nodeFqdn: null, targetAvailable: true },
      { scope: 'model', model: 'llama3.2:3b', targetKind: 'peer', peerId: 'peer-1', mode: 'prefer', nodeFqdn: PEER_A, targetAvailable: false },
    ]).join('\n');

    expect(text).toContain('all models');
    expect(text).toContain('this Hub');
    expect(text).toContain('llama3.2:3b');
    expect(text).toContain(PEER_A);
    expect(text).toContain('not usable right now');
    // The one thing an operator must not conclude from a red pin: that inference is broken.
    expect(text).toContain('can never take inference down');
  });

  it('says the peer is gone rather than printing a bare uuid for an unpaired target', () => {
    const text = formatPoolPinLines([
      {
        scope: 'default',
        targetKind: 'peer',
        peerId: '11111111-2222-3333-4444-555555555555',
        mode: 'prefer',
        nodeFqdn: null,
        targetAvailable: false,
      },
    ]).join('\n');

    expect(text).toContain('no longer paired');
  });

  it('folds the pins into pool status, and leaves the status of a pinless Hub unchanged', () => {
    const pinned = formatPoolStatusLines(
      status({ pins: [{ scope: 'default', targetKind: 'local', mode: 'prefer', nodeFqdn: null, targetAvailable: true }] }),
    ).join('\n');
    expect(pinned).toContain('Pins');

    // A Hub with no pins — including one running a build that has never heard of them — renders
    // exactly what it rendered before.
    expect(formatPoolStatusLines(status())).toEqual(formatPoolStatusLines(status({ pins: [] })));
    expect(formatPoolStatusLines(status()).join('\n')).not.toContain('Pins');
  });

  it('marks a routing-log row that a pin shaped, and leaves the others alone', () => {
    const log: PoolRoutingLogResponse = {
      summary: { recorded: 2, capacity: 200, served: 2, failed: 0, failovers: 0, lastAt: '2026-09-05T10:00:01.000Z' },
      entries: [
        {
          at: '2026-09-05T10:00:01.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'llama3.2:3b',
          node: PEER_A,
          peerId: 'peer-1',
          backend: 'ollama',
          candidates: 2,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'served',
          status: 200,
          durationMs: 12,
          pin: { scope: 'model', mode: 'prefer', targetKind: 'peer' },
        },
        {
          at: '2026-09-05T10:00:00.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'llama3.2:3b',
          node: 'local',
          peerId: null,
          backend: 'ollama',
          candidates: 2,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'served',
          status: 200,
          durationMs: 9,
        },
      ],
    };

    const text = formatPoolRoutingLogLines(log).join('\n');

    expect(text.match(/pinned/g)).toHaveLength(1);
    expect(text).toContain('pinned (this model → peer)');
  });

  it('posts an upsert and deletes by query, so a model id with a slash is addressable', async () => {
    hubApiFetch.mockResolvedValue({ pins: [] });

    await setPoolPin('.env.local', { scope: 'model', model: 'hf.co/org/repo:Q4_K_M', targetKind: 'peer', targetPeerId: 'peer-1' });
    await deletePoolPin('.env.local', 'model', 'hf.co/org/repo:Q4_K_M');
    await deletePoolPin('.env.local', 'default');

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/pins');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).body).toContain('hf.co/org/repo:Q4_K_M');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/pins?scope=model&model=hf.co%2Forg%2Frepo%3AQ4_K_M');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).method).toBe('DELETE');
    expect(hubApiFetch.mock.calls[2]?.[1]).toBe('/inference/pool/pins?scope=default');
  });
});

describe('hub-pool-cli pairing PIN', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('mints and revokes against the same route, with the mutation budget', async () => {
    hubApiFetch.mockResolvedValueOnce({ pin: '123456', expiresAt: '2026-09-05T10:10:00.000Z' });
    await mintPairingPin('.env.local');
    await cancelPairingPin('.env.local');

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/pairing-pin');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBe('POST');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/pool/pairing-pin');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).method).toBe('DELETE');
  });

  it('names the OTHER Hub as where the digits are typed, and that approval is still required', () => {
    // The one thing operators get backwards: the PIN is minted on the receiving Hub and typed on the
    // joining one, the opposite way round from every other pool command. Minting is not pre-approval.
    const text = formatPairingPinLines({ pin: '123456', expiresAt: '2026-09-05T10:10:00.000Z' }, 'hub-a.example-tailnet.ts.net').join('\n');

    expect(text).toContain('OTHER Hub');
    expect(text).toContain('cihub pool pair hub-a.example-tailnet.ts.net --pin 123456');
    expect(text).toContain('cihub pool approve');
  });

  it('falls back to the address placeholder when this node has no name to offer', () => {
    // `GET status` is best-effort here, so a Hub that cannot name itself still gets usable digits.
    const text = formatPairingPinLines({ pin: '004200', expiresAt: '2026-09-05T10:10:00.000Z' }, null).join('\n');

    expect(text).toContain('004200');
    expect(text).toContain('<this-node-address>');
  });

  it('reports an outstanding PIN in status, and nothing at all when there is none', () => {
    expect(formatPairingPinStateLines(undefined)).toEqual([]);
    expect(formatPairingPinStateLines({ active: false, expiresAt: null })).toEqual([]);

    const text = formatPairingPinStateLines({ active: true, expiresAt: '2026-09-05T10:10:00.000Z' }).join('\n');
    expect(text).toContain('2026-09-05 10:10:00Z');
    expect(text).toContain('cihub pool cancel-pin');
  });

  it('never prints the digits from a status payload', () => {
    // `GET status` reports only that a PIN exists; the mint is the sole place it is ever shown.
    const text = formatPoolStatusLines(status({ pairingPin: { active: true, expiresAt: '2026-09-05T10:10:00.000Z' } })).join('\n');
    expect(text).toContain('PIN outstanding');
    expect(text).not.toMatch(/\b\d{6}\b/);
  });
});

describe('hub-pool-cli peer auth mode', () => {
  it('names the peers still on a bearer token, because they are what blocks the switch', () => {
    const text = formatPeerAuthModeLines([peer({ authMode: 'bearer' }), peer({ id: 'b', nodeFqdn: PEER_B, authMode: 'signed' })], false).join('\n');

    expect(text).toContain(PEER_A);
    expect(text).not.toContain(PEER_B);
    expect(text).toContain('Do not set poolRequireSignedPeers');
  });

  it('says the switch is safe once every peer has upgraded', () => {
    const text = formatPeerAuthModeLines([peer({ authMode: 'signed' })], false).join('\n');

    expect(text).toContain('now safe');
  });

  it('calls out peers being refused when the switch is already on', () => {
    const text = formatPeerAuthModeLines([peer({ authMode: 'bearer' })], true).join('\n');

    expect(text).toContain('refused in both directions');
  });

  it('treats a peer that has not finished pairing as no evidence either way', () => {
    // A pending row has no auth mode yet, so it must neither be listed as a blocker nor counted as
    // an upgraded peer.
    expect(formatPeerAuthModeLines([peer({ status: 'pending' })], false)).toEqual([]);

    const text = formatPeerAuthModeLines([peer({ authMode: 'signed' }), peer({ id: 'b', nodeFqdn: PEER_B, status: 'pending' })], false).join('\n');
    expect(text).toContain('now safe');
    expect(text).not.toContain(PEER_B);
  });

  it('reads a Hub predating pinned identities as not yet upgraded, never as signed', () => {
    const text = formatPeerAuthModeLines([peer({ authMode: undefined })], false).join('\n');

    expect(text).toContain('legacy bearer token');
  });
});

describe('hub-pool-cli peers refusing this Hub', () => {
  const identityChanged = {
    kind: 'identity_changed' as const,
    httpStatus: 401,
    detail: 'capabilities probe returned 401 (identity-mismatch)',
    since: '2026-09-16T10:00:00.000Z',
    lastAttemptAt: '2026-09-17T14:00:00.000Z',
    attempts: 120,
    nextProbeAt: '2026-09-17T14:15:00.000Z',
    action: `${PEER_A} is now a different Hub Pool identity than the one paired here, so its Hub database was probably recreated. This Hub will not trust the new key by itself. Re-pair: (1) here: cihub pool unpair ${PEER_A}; (2) on ${PEER_A}: cihub pool pairing-pin; (3) here: cihub pool pair ${PEER_A} --pin <digits>; (4) on ${PEER_A}: cihub pool approve hub-a.example-tailnet.ts.net, after comparing the key fingerprint with this Hub's cihub pool status.`,
  };

  it('says the identity changed, since when, and prints every re-pair command whole', () => {
    const text = formatPoolStatusLines(
      status({ peers: [peer({ status: 'unreachable', consecutiveFailures: 3169, probeFailure: identityChanged })] }),
    ).join('\n');

    expect(text).toContain(`✗ ${PEER_A}  identity changed (HTTP 401) · 120 probe(s) since 2026-09-16 10:00:00Z · next probe 2026-09-17 14:15:00Z`);
    for (const command of [`cihub pool unpair ${PEER_A}`, 'cihub pool pairing-pin', `cihub pool pair ${PEER_A} --pin <digits>`]) {
      // Wrapped on word boundaries, so a command may span a line break but never loses a word.
      expect(text.replace(/\n\s+/g, ' ')).toContain(command);
    }
  });

  it('replaces the runaway strike count in the table, which read as a network fault on beta-max', () => {
    const [, , row] = formatPoolPeerTable([peer({ status: 'unreachable', consecutiveFailures: 3169, probeFailure: identityChanged })]);

    expect(row).toContain('identity changed');
    expect(row).not.toContain('3169/3');
  });

  it('wraps the action so no line in the box runs past the terminal', () => {
    const lines = formatPeerRefusalLines([peer({ probeFailure: identityChanged })]);

    expect(lines.slice(3).every((line) => line.length <= 100)).toBe(true);
  });

  it('lists nothing for an unreachable peer, a healthy one, or a Hub predating the field', () => {
    const unreachable = { ...identityChanged, kind: 'unreachable' as const, httpStatus: null, nextProbeAt: null, action: null };

    expect(formatPeerRefusalLines([peer({ probeFailure: unreachable }), peer({ probeFailure: null }), peer()])).toEqual([]);
    expect(formatPoolStatusLines(status()).join('\n')).not.toContain('refusing');
  });

  it('calls a bare 401 refused credentials, not a changed identity', () => {
    const unauthorized = { ...identityChanged, kind: 'unauthorized' as const, action: 'check the far side' };

    expect(formatPeerRefusalLines([peer({ probeFailure: unauthorized })]).join('\n')).toContain('credentials refused (HTTP 401)');
  });
});

describe('formatPairingPinLines', () => {
  const minted = (over: Record<string, unknown> = {}) => ({
    pin: '123456',
    expiresAt: '2026-09-08T01:50:32.710Z',
    nodeUuid: 'd5c2a2c9-78c0-4055-b8fb-779a219f9937',
    publicKeyFingerprint: '82:e7:a9:48:8e:05:a8:9f',
    identityError: null,
    ...over,
  });

  /**
   * `cihub pool pairing-pin` is named in four places in this repo and twice in docs/CLI.md, and
   * until now was not a subcommand at all — an operator following the probe output's own
   * instructions got "unknown subcommand". These assertions pin the output that instruction leads to.
   */
  it('shows the digits, the expiry and the exact command to run on the other Hub', () => {
    const text = formatPairingPinLines(minted()).join('\n');

    expect(text).toContain('123456');
    expect(text).toContain('cihub pool pair <this-node-address> --pin 123456');
    // Single-use and time-boxed are the two properties an operator must not have to guess at.
    expect(text).toContain('Single-use');
  });

  it('shows the key fingerprint, so the far operator has something to compare', () => {
    expect(formatPairingPinLines(minted()).join('\n')).toContain('82:e7:a9:48:8e:05:a8:9f');
  });

  it('surfaces an identity error rather than printing a PIN that cannot complete a handshake', () => {
    const text = formatPairingPinLines(minted({ identityError: 'keypair unreadable', publicKeyFingerprint: null })).join('\n');

    expect(text).toContain('keypair unreadable');
  });

  it('says what cancelling actually costs', () => {
    expect(formatPairingPinCancelledLines().join('\n')).toContain('cancelled');
  });
});
