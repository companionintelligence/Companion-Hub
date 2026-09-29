import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DiscoverablePoolPeer,
  type PoolPeerRow,
  type PoolProbeResult,
  type PoolRoutingLogResponse,
  type PoolStatusResponse,
  cancelPairingPin,
  fetchInferencePreferences,
  formatContextCapResultLines,
  formatLocalContextCapLines,
  formatLocalOllamaSlotsLines,
  formatOllamaSlotsResultLines,
  formatPairingPinCancelledLines,
  formatPairingPinLines,
  formatPairingPinStateLines,
  formatPeerAuthModeLines,
  formatPeerContextCapLines,
  formatPeerRefusalLines,
  formatPoolDiscoverLines,
  formatPoolContextCapLines,
  formatPoolPeerTable,
  formatPoolPeersLines,
  formatPoolProbeLines,
  formatPoolRoutingLogLines,
  formatPoolPinLines,
  formatPoolStatusLines,
  formatPoolTimestamp,
  formatPromptCeilingResultLines,
  deletePoolPin,
  setPoolPin,
  probePoolAddress,
  mintPairingPin,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setInferenceContextCap,
  setInferenceOllamaSlots,
  peerContextCap,
  setPoolEnabledSetting,
  setPoolMaxPromptTokens,
  summariseContextCaps,
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

  /**
   * The row this whole change exists for. Reproduced from beta-max, 2026-09-21: four rows reading
   * `qwen3-coder:30b  -  1/14  30031  x failed` were reported as "placement returns no candidate and
   * times out", when placement had ranked fourteen and the app had hung up on the first after 30 s.
   * The NODE column and the summary are where that misreading happened, so both are asserted here.
   */
  it('says the caller left, and names the node it left waiting, instead of an anonymous failure', () => {
    const text = formatPoolRoutingLogLines({
      entries: [
        {
          at: '2026-09-21T20:09:06.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'qwen3-coder:30b',
          node: 'local',
          peerId: null,
          backend: 'ollama',
          candidates: 14,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'failed',
          status: null,
          durationMs: 30031,
          clientClosed: true,
        },
      ],
      summary: { recorded: 26, capacity: 200, served: 22, failed: 4, clientClosed: 4, failovers: 0, lastAt: '2026-09-21T20:09:06.000Z' },
    }).join('\n');

    expect(text).toContain('4 failed (4 abandoned by the caller)');
    expect(text).toContain('↳ the app closed its connection after 30031 ms; local had not answered yet');
    expect(text).toContain('not a routing failure');
    // The node the request was placed on, where an operator looks first — not the `-` that says
    // nothing was selected.
    expect(text).not.toMatch(/qwen3-coder:30b\s+-\s/);
  });

  /**
   * core-2, 2026-09-26: the row read `qwen3.8:27b  -  9/9  307336  x failed` with a nine-node chain,
   * for a turn no node could run. Now the walk stops at the first node, and the row has to say why a
   * named node "failed" without the pool trying any other.
   */
  it('says the request itself was refused, by whom, and how many candidates it was not sent to', () => {
    const row = {
      at: '2026-09-26T23:51:12.000Z',
      direction: 'outbound' as const,
      path: '/api/chat',
      model: 'qwen3.8:27b',
      node: 'core-14.capybara-ulmer.ts.net',
      peerId: 'p14',
      backend: 'ollama',
      candidates: 9,
      attempt: 1,
      failedOverFrom: [],
      outcome: 'failed' as const,
      status: 500,
      durationMs: 128,
    };
    const summary = { recorded: 1, capacity: 200, served: 0, failed: 1, failovers: 0, lastAt: '2026-09-26T23:51:12.000Z' };

    const definitive = formatPoolRoutingLogLines({
      entries: [{ ...row, requestError: { signature: 'no-user-query', basis: 'definitive', confirms: null } }],
      summary,
    }).join('\n');
    expect(definitive).toContain('✗ failed 500');
    expect(definitive).toContain(
      '↳ core-14.capybara-ulmer.ts.net refused the request itself (no user message for the chat template); returned to the app, not sent to the other 8 candidates',
    );

    const confirmed = formatPoolRoutingLogLines({
      entries: [
        {
          ...row,
          node: 'core-17.capybara-ulmer.ts.net',
          attempt: 2,
          failedOverFrom: ['core-14.capybara-ulmer.ts.net'],
          requestError: { signature: 'chat-template', basis: 'confirmed', confirms: 'core-14.capybara-ulmer.ts.net' },
        },
      ],
      summary,
    }).join('\n');
    expect(confirmed).toContain(
      '↳ core-17.capybara-ulmer.ts.net refused the request itself, as core-14.capybara-ulmer.ts.net had (chat template would not render); returned to the app, not sent to the other 7 candidates',
    );
    // The refusal is the reason the chain is one node long, so it reads before the chain does.
    expect(confirmed.indexOf('refused the request itself')).toBeLessThan(confirmed.indexOf('failed over from'));
  });

  /**
   * A verdict the walk ended on because nobody was left to ask — a single Lemonade node answering
   * `500 Missing 'content'` — and a 4xx relayed on its status. The first must not claim the pool
   * spared "the other 0 candidates"; the second names no engine message, because none was read.
   */
  it('says when the refusal came from the last candidate, and names a 4xx by its status', () => {
    const row = {
      at: '2026-09-29T10:00:00.000Z',
      direction: 'outbound' as const,
      path: '/v1/chat/completions',
      model: 'qwen3.8:27b',
      node: 'core-2.capybara-ulmer.ts.net',
      peerId: 'p2',
      backend: 'lemonade',
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      outcome: 'failed' as const,
      status: 500,
      durationMs: 42,
    };
    const summary = { recorded: 1, capacity: 200, served: 0, failed: 1, failovers: 0, requestErrors: 1, lastAt: row.at };

    const last = formatPoolRoutingLogLines({
      entries: [{ ...row, requestError: { signature: 'invalid-message', basis: 'last-candidate', confirms: null } }],
      summary,
    }).join('\n');
    expect(last).toContain(
      '↳ core-2.capybara-ulmer.ts.net refused the request itself (a malformed message); returned to the app unconfirmed, as no candidate was left to ask',
    );
    expect(last).not.toContain('other 0 candidates');

    const status = formatPoolRoutingLogLines({
      entries: [
        { ...row, backend: 'ollama', candidates: 9, status: 400, requestError: { signature: 'client-error', basis: 'status', confirms: null } },
      ],
      summary,
    }).join('\n');
    expect(status).toContain('✗ failed 400');
    expect(status).toContain(
      '↳ core-2.capybara-ulmer.ts.net refused the request itself (an HTTP 4xx, relayed on its status); returned to the app, not sent to the other 8 candidates',
    );
  });

  it('breaks out the requests an engine refused as bad, beside the hang-ups, from the failures', () => {
    const entries: PoolRoutingLogResponse['entries'] = [];
    const base = { recorded: 26, capacity: 200, served: 23, failed: 3, failovers: 0, lastAt: null };

    expect(formatPoolRoutingLogLines({ entries, summary: { ...base, clientClosed: 1, requestErrors: 2 } }).join('\n')).toContain(
      '3 failed (1 abandoned by the caller, 2 refused as bad requests) ·',
    );
    expect(formatPoolRoutingLogLines({ entries, summary: { ...base, clientClosed: 0, requestErrors: 1 } }).join('\n')).toContain(
      '3 failed (1 refused as a bad request) ·',
    );
  });

  it('leaves the counts line alone on a Hub that reports no hang-ups, and on one too old to report them', () => {
    const entries: PoolRoutingLogResponse['entries'] = [];
    const base = { recorded: 3, capacity: 200, served: 3, failed: 0, failovers: 0, lastAt: null };

    expect(formatPoolRoutingLogLines({ entries, summary: { ...base, clientClosed: 0, requestErrors: 0 } }).join('\n')).toContain('0 failed ·');
    // Absent, not zero: an older Hub must not be made to claim none of its failures were hang-ups.
    expect(formatPoolRoutingLogLines({ entries, summary: base }).join('\n')).toContain('0 failed ·');
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

describe('hub-pool-cli prompt ceiling', () => {
  const FZZY = 'hub-d.example-tailnet.ts.net';

  function routingEntry(overrides: Partial<PoolRoutingLogResponse['entries'][number]> = {}): PoolRoutingLogResponse['entries'][number] {
    return {
      at: '2026-09-17T10:00:01.000Z',
      direction: 'outbound',
      path: '/v1/chat/completions',
      model: 'qwen3-coder:30b',
      node: PEER_A,
      peerId: 'peer-1',
      backend: 'ollama',
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      outcome: 'served',
      status: 200,
      durationMs: 268_000,
      ...overrides,
    };
  }

  function logOf(entries: PoolRoutingLogResponse['entries']): string {
    const summary = { recorded: entries.length, capacity: 200, served: entries.length, failed: 0, failovers: 0, lastAt: '2026-09-17T10:00:01.000Z' };
    return formatPoolRoutingLogLines({ summary, entries }).join('\n');
  }

  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('PATCHes only the ceiling, and sends an explicit null to clear it', async () => {
    hubApiFetch.mockResolvedValue({});

    await setPoolMaxPromptTokens('.env.local', 16_000);
    await setPoolMaxPromptTokens('.env.local', null);

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/pool/settings');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBe('PATCH');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).body).toBe('{"poolMaxPromptTokens":16000}');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    // Omitting the field would leave the old ceiling in place: null is the "clear".
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).body).toBe('{"poolMaxPromptTokens":null}');
  });

  it('shows this node’s ceiling in status, naming the .env when that is what sets it', () => {
    const base = status();
    const fromSetting = formatPoolStatusLines({
      ...base,
      localNode: { ...base.localNode, maxPromptTokens: 16_000, maxPromptTokensSetBy: 'setting' },
    });
    const fromEnv = formatPoolStatusLines({ ...base, localNode: { ...base.localNode, maxPromptTokens: 8_000, maxPromptTokensSetBy: 'env' } });

    expect(fromSetting.join('\n')).toContain('Ceiling    prompts over ~16000 tokens');
    expect(fromSetting.join('\n')).toContain('cihub pool ceiling clear');
    expect(fromEnv.join('\n')).toContain('HUB_POOL_MAX_PROMPT_TOKENS');
  });

  it('lists the peers advertising a ceiling, and leaves the status of a fleet without one unchanged', () => {
    const limited = formatPoolStatusLines(status({ peers: [peer(), peer({ id: 'fzzy-row', nodeFqdn: FZZY, maxPromptTokens: 16_000 })] })).join('\n');

    expect(limited).toContain('Prompt ceilings');
    expect(limited).toContain(`${FZZY}`);
    expect(limited).toContain('~16000 tokens');
    // No ceiling anywhere — including a Hub predating the field, and one reporting explicit nulls —
    // renders exactly what it rendered before.
    const base = status();
    const nulls = status({ peers: [peer({ maxPromptTokens: null })] });
    const unchanged = formatPoolStatusLines(base);
    expect(formatPoolStatusLines({ ...nulls, localNode: { ...nulls.localNode, maxPromptTokens: null, maxPromptTokensSetBy: null } })).toEqual(
      unchanged,
    );
    expect(unchanged.join('\n')).not.toContain('eiling');
  });

  it('marks a routing-log row the ceiling changed, naming the node it skipped and at what ceiling', () => {
    const text = logOf([
      routingEntry({
        promptCeiling: { estimatedTokens: 46_031, excluded: [{ node: FZZY, maxPromptTokens: 16_000 }], overridden: false },
      }),
    ]);

    expect(text).toContain(`~46031-token prompt skipped ${FZZY} (ceiling 16000)`);
  });

  it('marks a routing-log row that followed its prompt prefix, and one whose remembered node was too busy', () => {
    const text = logOf([
      routingEntry({ affinity: { key: 'hashed', outcome: 'hit', remembered: PEER_A, inFlight: 1, maxInFlight: 2 } }),
      routingEntry({ node: 'local', peerId: null, affinity: { key: 'header', outcome: 'skipped', remembered: PEER_A, inFlight: 2, maxInFlight: 2 } }),
      routingEntry({ node: 'local', peerId: null, affinity: { key: 'header', outcome: 'skipped', remembered: PEER_A, inFlight: 0, maxInFlight: 2 } }),
      routingEntry({ affinity: { key: 'hashed', outcome: 'miss', remembered: null, inFlight: null, maxInFlight: 2 } }),
      routingEntry({ affinity: null }),
      routingEntry(),
    ]);

    // Each line says whether the app named the session or the proxy digested it from the prompt: a
    // `hit` on a session's first turn (core-2, 2026-09-21) is a key naming too many sessions, and
    // which kind of key it was is the first question.
    expect(text).toContain(`followed its prompt prefix to ${PEER_A} (1 in flight, limit 2; session from prompt digest)`);
    expect(text).toContain(`${PEER_A} holds this prompt's prefix but had 2 in flight (limit 2); ranked as usual (session from X-Hub-Pool-Session)`);
    expect(text).toContain(
      `${PEER_A} holds this prompt's prefix and was under the limit, but a ceiling, a demotion or a pin placed another node first (session from X-Hub-Pool-Session)`,
    );
    // A miss, an off row, and a row from a Hub predating affinity add nothing.
    expect(text.match(/prefix/g)).toHaveLength(3);
  });

  it('says so when a long prompt was placed over a ceiling after all, rather than hiding the override', () => {
    const text = logOf([
      routingEntry({
        node: FZZY,
        promptCeiling: { estimatedTokens: 46_031, excluded: [{ node: FZZY, maxPromptTokens: 16_000 }], overridden: true },
      }),
    ]);

    // Worded for both ways it happens — every candidate over its ceiling, or every one under a ceiling failed.
    expect(text).toContain(`~46031-token prompt placed anyway over the ceiling of ${FZZY} (ceiling 16000)`);
    expect(text).not.toContain('skipped');
  });

  it('adds nothing to a row the ceiling did not change', () => {
    const text = logOf([
      routingEntry({ promptCeiling: { estimatedTokens: 2_000, excluded: [], overridden: false } }),
      routingEntry({ promptCeiling: null }),
      routingEntry(),
    ]);

    expect(text).not.toContain('prompt');
  });

  it('marks a routing-log row a context cap changed, naming the node it skipped, its cap, and the window asked for', () => {
    const text = logOf([
      routingEntry({ contextCap: { numCtx: 65_536, source: 'request', excluded: [{ node: FZZY, maxNumCtx: 16_384 }], overridden: false } }),
      routingEntry({ contextCap: { numCtx: 46_031, source: 'estimated', excluded: [{ node: FZZY, maxNumCtx: 16_384 }], overridden: false } }),
      routingEntry({
        node: FZZY,
        contextCap: { numCtx: 65_536, source: 'request', excluded: [{ node: FZZY, maxNumCtx: 16_384 }], overridden: true },
      }),
      routingEntry({ contextCap: { numCtx: 4096, source: 'request', excluded: [], overridden: false } }),
      routingEntry({ contextCap: null }),
      routingEntry(),
    ]);

    expect(text).toContain(`num_ctx 65536 skipped ${FZZY} (cap 16384)`);
    expect(text).toContain(`~46031-token prompt with no num_ctx skipped ${FZZY} (cap 16384)`);
    expect(text).toContain(`num_ctx 65536 placed anyway over the context cap of ${FZZY} (cap 16384)`);
    // A row every node could take, an uncapped fleet, and a Hub predating cap placement add nothing.
    expect(text.match(/cap 16384/g)).toHaveLength(3);
  });

  describe('formatPromptCeilingResultLines', () => {
    const settings = (poolMaxPromptTokens: number | null) => ({ ...status().settings, poolMaxPromptTokens });
    const statusIn = (maxPromptTokens: number | null, maxPromptTokensSetBy: 'env' | 'setting' | null) => {
      const base = status();
      return { ...base, localNode: { ...base.localNode, maxPromptTokens, maxPromptTokensSetBy } };
    };

    it('confirms a ceiling that is in force', () => {
      const result = formatPromptCeilingResultLines(16_000, settings(16_000), statusIn(16_000, 'setting'));

      expect(result.tone).toBe('green');
      expect(result.title).toBe('Prompt ceiling set');
      expect(result.lines.join('\n')).toContain('about 64 KB');
    });

    it('confirms a clear', () => {
      expect(formatPromptCeilingResultLines(null, settings(null), statusIn(null, null))).toMatchObject({ title: 'Prompt ceiling cleared' });
    });

    it('still confirms when the status read failed, since the write itself landed', () => {
      expect(formatPromptCeilingResultLines(16_000, settings(16_000), null)).toMatchObject({ title: 'Prompt ceiling set' });
    });

    it('reports the .env override instead of success, whichever way the request went', () => {
      expect(formatPromptCeilingResultLines(16_000, settings(16_000), statusIn(8_000, 'env'))).toMatchObject({ tone: 'yellow' });
      expect(formatPromptCeilingResultLines(null, settings(null), statusIn(8_000, 'env')).lines.join('\n')).toContain('changed nothing in effect');
      // An env value that happens to equal the request is not a conflict worth alarming anyone over.
      expect(formatPromptCeilingResultLines(8_000, settings(8_000), statusIn(8_000, 'env'))).toMatchObject({ tone: 'green' });
    });

    it('says an older Hub stored nothing', () => {
      const result = formatPromptCeilingResultLines(16_000, status().settings, null);

      expect(result.tone).toBe('red');
      expect(result.lines.join('\n')).toContain('predates prompt ceilings');
    });
  });
});

describe('hub-pool-cli context cap', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('reads the preferences, and PATCHes the cap with the backend it was given — null to clear', async () => {
    hubApiFetch.mockResolvedValue({ preferredBackend: 'ollama', maxNumCtx: null });

    await fetchInferencePreferences('.env.local');
    await setInferenceContextCap('.env.local', 'ollama', 16_384);
    await setInferenceContextCap('.env.local', 'vllm', null);

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/preferences');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBeUndefined();
    // The preferences route, not /api/user-settings: it is the one that can remove the key, and it
    // requires `backend`, so the stored one is sent back.
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/inference/preferences');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).method).toBe('PATCH');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).body).toBe('{"backend":"ollama","maxNumCtx":16384}');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    // Omitting the field would leave the old cap in place: null is the "clear".
    expect((hubApiFetch.mock.calls[2]?.[2] as RequestInit).body).toBe('{"backend":"vllm","maxNumCtx":null}');
  });

  describe('per-peer caps: the column, the comparison, and the three readings', () => {
    const capped = (id: string, node: string, maxNumCtx: number | null | undefined, rest: Partial<PoolPeerRow> = {}) =>
      peer({ id, nodeFqdn: node, ...(maxNumCtx === undefined ? {} : { maxNumCtx }), ...rest });

    it('renders a number, `none` and `?` as three different cells, never as a default', () => {
      // `none` is a peer that answered and named no cap — routing reads it as "takes any window".
      // `?` is a peer nothing is known about, or a Hub whose rows predate the field. A cap column
      // that showed either as a number is how an operator concludes a fleet is uniform when it is not.
      expect(peerContextCap(capped('a', PEER_A, 65_536))).toBe(65_536);
      expect(peerContextCap(capped('b', PEER_B, null))).toBeNull();
      expect(peerContextCap(capped('c', PEER_B, null, { lastCapabilities: null }))).toBeUndefined();
      expect(peerContextCap(capped('d', PEER_B, undefined))).toBeUndefined();

      const table = formatPoolPeerTable([
        capped('a', PEER_A, 65_536),
        capped('b', PEER_B, null),
        capped('c', 'hub-d.example-tailnet.ts.net', null, { lastCapabilities: null }),
      ]).join('\n');

      expect(table).toContain('CONTEXT');
      expect(table).toMatch(/65536\s+ollama/);
      expect(table).toMatch(/none\s+ollama/);
      expect(table).toMatch(/\?\s+-/);
    });

    it('summarises a spread, a mix and a uniform pool, and counts only what is known', () => {
      const spread = summariseContextCaps([
        { node: 'core-14', cap: 8_192 },
        { node: 'core-2', cap: 65_536 },
        { node: 'beta-nas', cap: null },
        { node: 'unpolled', cap: undefined },
      ]);

      expect(spread).toMatchObject({ smallest: 8_192, largest: 65_536, disagrees: true, mixed: true });
      expect(spread.uncapped).toEqual(['beta-nas']);
      expect(spread.unknown).toEqual(['unpolled']);
      // One cap repeated is agreement, and an all-uncapped pool is neither a spread nor a mix.
      expect(
        summariseContextCaps([
          { node: 'a', cap: 65_536 },
          { node: 'b', cap: 65_536 },
        ]),
      ).toMatchObject({ disagrees: false, mixed: false });
      expect(
        summariseContextCaps([
          { node: 'a', cap: null },
          { node: 'b', cap: null },
        ]),
      ).toMatchObject({ disagrees: false, mixed: false });
    });

    it('names the nodes a disagreement places behind, and the uncapped node that collects the large windows', () => {
      const text = formatPoolContextCapLines(
        status({
          localNode: { ...status().localNode, maxNumCtx: 65_536 },
          peers: [capped('a', PEER_A, 16_384), capped('b', PEER_B, null)],
        }),
      ).join('\n');

      expect(text).toContain('Context caps');
      expect(text).toContain('caps disagree across this pool (16384 … 65536)');
      expect(text).toContain(`${PEER_A} at 16384 is placed behind`);
      expect(text).toContain(`no cap on ${PEER_B}`);
      expect(text).toContain('cihub fleet backends --backends ollama --ollama-context <N> --execute');
    });

    it('says nothing when every node agrees, and nothing at all when the whole pool is uncapped', () => {
      const agreed = formatPoolContextCapLines(
        status({ localNode: { ...status().localNode, maxNumCtx: 65_536 }, peers: [capped('a', PEER_A, 65_536)] }),
      ).join('\n');

      expect(agreed).toContain('Context caps');
      expect(agreed).not.toContain('disagree');
      expect(agreed).not.toContain('no cap on');
      // A pool where nothing is capped behaves exactly as the build before caps did. Say nothing.
      expect(formatPoolContextCapLines(status({ peers: [capped('a', PEER_A, null)] }))).toEqual([]);
    });

    it('ignores peers that cannot be routed to, so a disabled or unreachable node raises no warning', () => {
      const lines = formatPoolContextCapLines(
        status({
          localNode: { ...status().localNode, maxNumCtx: 65_536 },
          peers: [capped('a', PEER_A, 16_384, { enabled: false }), capped('b', PEER_B, 8_192, { status: 'unreachable' })],
        }),
      ).join('\n');

      expect(lines).not.toContain('disagree');
      expect(lines).not.toContain(PEER_A);
    });

    it("marks an unknown cap as unknown rather than folding it into 'uncapped'", () => {
      const lines = formatPoolContextCapLines(
        status({ localNode: { ...status().localNode, maxNumCtx: 65_536 }, peers: [capped('a', PEER_A, undefined)] }),
      ).join('\n');

      expect(lines).toContain(`no cap known for ${PEER_A}`);
      expect(lines).not.toContain('no cap on');
    });

    it('adds one comparison line to `pool peers`, and nothing when the peers agree', () => {
      const disagreeing = formatPeerContextCapLines([capped('a', PEER_A, 16_384), capped('b', PEER_B, 65_536)]).join('\n');
      expect(disagreeing).toContain('peer context caps disagree (16384 … 65536)');

      expect(formatPeerContextCapLines([capped('a', PEER_A, 65_536), capped('b', PEER_B, 65_536)])).toEqual([]);
      // And it reaches the real `pool peers` output, under the table that carries the numbers.
      expect(formatPoolPeersLines([capped('a', PEER_A, 16_384), capped('b', PEER_B, null)]).join('\n')).toContain(
        'advertises no context cap while others are capped',
      );
    });
  });

  it('shows this node’s cap in status, and nothing on a node without one or a Hub predating caps', () => {
    const base = status();
    const capped = formatPoolStatusLines({ ...base, localNode: { ...base.localNode, maxNumCtx: 16_384 } }).join('\n');
    expect(capped).toContain('Context    apps are handed a num_ctx of at most 16384 tokens');
    expect(capped).toContain('cihub pool context-cap clear');
    expect(formatLocalContextCapLines({ ...base.localNode, maxNumCtx: null })).toEqual([]);
    expect(formatLocalContextCapLines(base.localNode)).toEqual([]);
    expect(formatPoolStatusLines(base).join('\n')).not.toContain('Context    ');
  });

  describe('formatContextCapResultLines', () => {
    const prefs = (maxNumCtx: number | null) => ({ preferredBackend: 'ollama', maxNumCtx });

    it('confirms a cap that read back as requested, and names the engine setting it must match', () => {
      const result = formatContextCapResultLines(16_384, prefs(null), prefs(16_384), true);
      expect(result.tone).toBe('green');
      expect(result.title).toBe('Context cap set');
      expect(result.lines.join('\n')).toContain('at most 16384 tokens');
      expect(result.lines.join('\n')).toContain('OLLAMA_CONTEXT_LENGTH on this node should be 16384');
    });

    it('confirms a clear, saying what the sizing goes back to', () => {
      const result = formatContextCapResultLines(null, prefs(65_536), prefs(null), true);
      expect(result).toMatchObject({ title: 'Context cap cleared', tone: 'yellow' });
      expect(result.lines.join('\n')).toContain('model window');
    });

    it('says nothing was written when the cap already read as requested', () => {
      expect(formatContextCapResultLines(16_384, prefs(16_384), null, false)).toMatchObject({ title: 'Context cap unchanged' });
      expect(formatContextCapResultLines(null, prefs(null), null, false).lines.join('\n')).toContain('nothing to clear');
    });

    it('does not report success when the read-back disagrees with the request', () => {
      const result = formatContextCapResultLines(16_384, prefs(null), prefs(null), true);
      expect(result.tone).toBe('red');
      expect(result.lines.join('\n')).toContain('reads back no cap');
    });

    it('says an older Hub stored nothing', () => {
      const result = formatContextCapResultLines(16_384, { preferredBackend: 'ollama' }, null, false);
      expect(result.tone).toBe('red');
      expect(result.lines.join('\n')).toContain('predates the context cap');
    });
  });
});

describe('hub-pool-cli Ollama slots', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

  it('PATCHes the slot count through the preferences route with the backend it was given — null to clear', async () => {
    hubApiFetch.mockResolvedValue({ preferredBackend: 'ollama', ollamaSlots: null });

    await setInferenceOllamaSlots('.env.local', 'ollama', 4);
    await setInferenceOllamaSlots('.env.local', 'vllm', null);

    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/inference/preferences');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).method).toBe('PATCH');
    expect((hubApiFetch.mock.calls[0]?.[2] as RequestInit).body).toBe('{"backend":"ollama","ollamaSlots":4}');
    expect((hubApiFetch.mock.calls[1]?.[2] as RequestInit).body).toBe('{"backend":"vllm","ollamaSlots":null}');
  });

  it('shows this node’s slot count in status with the knob’s state, and nothing when none is stated or the Hub predates slots', () => {
    const base = status();
    const stated = formatPoolStatusLines({ ...base, localNode: { ...base.localNode, ollamaSlots: 4 } }).join('\n');
    expect(stated).toContain('Slots      Ollama runs 4 requests at once; slot-aware placement off (poolSlotAwareness=0)');
    expect(stated).toContain('cihub pool slots clear');
    const on = formatLocalOllamaSlotsLines({ ...base.localNode, ollamaSlots: 1 }, { ...base.settings, poolSlotAwareness: 1 }).join('\n');
    expect(on).toContain('Ollama runs 1 request at once; slot-aware placement on');
    expect(formatLocalOllamaSlotsLines({ ...base.localNode, ollamaSlots: null }, base.settings)).toEqual([]);
    expect(formatLocalOllamaSlotsLines(base.localNode, base.settings)).toEqual([]);
    expect(formatPoolStatusLines(base).join('\n')).not.toContain('Slots      ');
  });

  describe('formatOllamaSlotsResultLines', () => {
    const prefs = (ollamaSlots: number | null) => ({ preferredBackend: 'ollama', ollamaSlots });

    it('confirms a count that read back as requested, and names the daemon setting it must match', () => {
      const result = formatOllamaSlotsResultLines(4, prefs(null), prefs(4), true);
      expect(result.tone).toBe('green');
      expect(result.title).toBe('Slot count set');
      expect(result.lines.join('\n')).toContain('runs 4 requests at once');
      expect(result.lines.join('\n')).toContain('OLLAMA_NUM_PARALLEL on this node should be 4');
      expect(result.lines.join('\n')).toContain('cihub fleet backends --ollama-parallel 4');
    });

    it('recommends the fleet command with the node’s other runtime flags, and says what the bare flag would drop', () => {
      // The runtime drop-in is rendered whole from the flags on the line: `--ollama-parallel 4 --execute`
      // alone would rewrite every node's file without OLLAMA_KEEP_ALIVE / OLLAMA_CONTEXT_LENGTH and
      // restart the daemon to make it so. The box must never hand the operator that command bare.
      const text = formatOllamaSlotsResultLines(4, prefs(null), prefs(4), true).lines.join('\n');
      expect(text).toContain('--ollama-parallel 4 --ollama-context <n> --ollama-keep-alive <d> --execute');
      expect(text).toContain('rendered whole from the flags');
      expect(text).toContain('--ollama-parallel 4 alone would drop OLLAMA_KEEP_ALIVE and OLLAMA_CONTEXT_LENGTH');
      expect(text).not.toMatch(/--ollama-parallel 4 --execute/);
    });

    it('confirms a clear, saying what ranking goes back to', () => {
      const result = formatOllamaSlotsResultLines(null, prefs(2), prefs(null), true);
      expect(result).toMatchObject({ title: 'Slot count cleared', tone: 'yellow' });
      expect(result.lines.join('\n')).toContain('queue depth alone');
    });

    it('says nothing was written when the count already read as requested', () => {
      expect(formatOllamaSlotsResultLines(4, prefs(4), null, false)).toMatchObject({ title: 'Slot count unchanged' });
      expect(formatOllamaSlotsResultLines(null, prefs(null), null, false).lines.join('\n')).toContain('nothing to clear');
    });

    it('does not report success when the read-back disagrees with the request', () => {
      const result = formatOllamaSlotsResultLines(4, prefs(null), prefs(2), true);
      expect(result.tone).toBe('red');
      expect(result.lines.join('\n')).toContain('reads back 2');
    });

    it('says an older Hub stored nothing', () => {
      const result = formatOllamaSlotsResultLines(4, { preferredBackend: 'ollama' }, null, false);
      expect(result.tone).toBe('red');
      expect(result.lines.join('\n')).toContain('predates the slot count');
    });
  });

  describe('pool log', () => {
    const BETA_MAX = 'hub-c.example-tailnet.ts.net';

    function routingEntry(overrides: Partial<PoolRoutingLogResponse['entries'][number]> = {}): PoolRoutingLogResponse['entries'][number] {
      return {
        at: '2026-09-21T10:00:01.000Z',
        direction: 'outbound',
        path: '/v1/chat/completions',
        model: 'qwen3-coder:30b',
        node: PEER_A,
        peerId: 'peer-1',
        backend: 'ollama',
        candidates: 3,
        attempt: 1,
        failedOverFrom: [],
        outcome: 'served',
        status: 200,
        durationMs: 470,
        ...overrides,
      };
    }

    function logOf(entries: PoolRoutingLogResponse['entries']): string {
      const summary = {
        recorded: entries.length,
        capacity: 200,
        served: entries.length,
        failed: 0,
        failovers: 0,
        lastAt: '2026-09-21T10:00:01.000Z',
      };
      return formatPoolRoutingLogLines({ summary, entries }).join('\n');
    }

    it('marks a row a full engine was moved on, with its queue depth and slots', () => {
      const text = logOf([
        routingEntry({
          slots: { demoted: [{ node: BETA_MAX, backend: 'ollama', inFlight: 2, slots: 2 }], overridden: false },
        }),
      ]);

      expect(text).toContain(`↳ moved ${BETA_MAX} (2 in flight, 2 slots) behind nodes with a free slot`);
    });

    it('names this node as local, lists every demoted node in ranked order, and says "slot" for one', () => {
      const text = logOf([
        routingEntry({
          slots: {
            demoted: [
              { node: 'local', backend: 'ollama', inFlight: 3, slots: 1 },
              { node: BETA_MAX, backend: 'ollama', inFlight: 2, slots: 2 },
            ],
            overridden: false,
          },
        }),
      ]);

      expect(text).toContain(`↳ moved local (3 in flight, 1 slot), ${BETA_MAX} (2 in flight, 2 slots) behind nodes with a free slot`);
    });

    it('says so when the request was placed on a full engine anyway', () => {
      // Every candidate full, every free one failed first, or a ceiling put the free ones behind it:
      // the log must read "placed anyway", never claim the node was skipped.
      const text = logOf([
        routingEntry({
          node: BETA_MAX,
          slots: { demoted: [{ node: BETA_MAX, backend: 'ollama', inFlight: 2, slots: 2 }], overridden: true },
        }),
      ]);

      expect(text).toContain(`↳ placed anyway with every slot full on ${BETA_MAX} (2 in flight, 2 slots): no node with a free slot was ahead of it`);
      expect(text).not.toContain('moved');
    });

    it('adds nothing to a row the slots did not change, with the knob off, or from a Hub predating slots', () => {
      const text = logOf([
        // Some candidate stated a count, but every one had a free slot: the record is present and empty.
        routingEntry({ slots: { demoted: [], overridden: false } }),
        routingEntry({ slots: null }),
        routingEntry(),
      ]);

      expect(text).not.toContain('slot');
      expect(text).not.toContain('↳');
    });
  });
});

describe('hub-pool-cli local engine contention', () => {
  const CORE_2 = 'hub-e.example-tailnet.ts.net';
  /** beta-max at 23:50:22Z: OpenClaw's 27b turn and a Hermes /v1 request for 35b on its Ollama, which states no default window. */
  const betaMax = {
    node: 'local',
    backend: 'ollama',
    busyWith: [
      { model: 'qwen3.8:27b', numCtx: 65_536 },
      { model: 'qwen3.6:35b', numCtx: null },
    ],
    runsAt: 65_536,
    behind: [CORE_2],
  };
  const engine = 'local (busy with qwen3.8:27b at num_ctx 65536, qwen3.6:35b at the engine default; this one at num_ctx 65536)';

  function routingEntry(overrides: Partial<PoolRoutingLogResponse['entries'][number]> = {}): PoolRoutingLogResponse['entries'][number] {
    return {
      at: '2026-09-26T23:50:22.068Z',
      direction: 'outbound',
      path: '/api/chat',
      model: 'qwen3.6:35b',
      node: CORE_2,
      peerId: 'peer-2',
      backend: 'ollama',
      candidates: 2,
      attempt: 1,
      failedOverFrom: [],
      outcome: 'served',
      status: 200,
      durationMs: 2_100,
      ...overrides,
    };
  }

  function logOf(entries: PoolRoutingLogResponse['entries']): string {
    const summary = { recorded: entries.length, capacity: 200, served: entries.length, failed: 0, failovers: 0, lastAt: '2026-09-26T23:50:22.068Z' };
    return formatPoolRoutingLogLines({ summary, entries }).join('\n');
  }

  it('marks a row this node was moved on, with the work there the request could not join and the nodes it gave way to', () => {
    const text = logOf([routingEntry({ contention: { numCtx: 65_536, demoted: [betaMax], overridden: false } })]);

    expect(text).toContain(`↳ moved ${engine} behind ${CORE_2}`);
  });

  it('names a window this node could not state as the engine default', () => {
    const text = logOf([
      routingEntry({
        path: '/v1/chat/completions',
        contention: {
          numCtx: null,
          demoted: [{ ...betaMax, busyWith: [{ model: 'qwen3.6:35b', numCtx: 65_536 }], runsAt: null }],
          overridden: false,
        },
      }),
    ]);

    expect(text).toContain(`↳ moved local (busy with qwen3.6:35b at num_ctx 65536; this one at the engine default) behind ${CORE_2}`);
  });

  it('says so when failover reached the contended engine anyway', () => {
    const text = logOf([
      routingEntry({
        node: 'local',
        peerId: null,
        failedOverFrom: [CORE_2],
        attempt: 2,
        contention: { numCtx: 65_536, demoted: [betaMax], overridden: true },
      }),
    ]);

    expect(text).toContain(`↳ placed anyway on ${engine}: nothing it gave way to answered`);
    expect(text).not.toContain('moved');
  });

  it('says why a contended engine kept its place: every node after it was busier, or moved behind it by a line above', () => {
    const text = logOf([
      routingEntry({
        node: 'local',
        peerId: null,
        contention: { numCtx: 65_536, demoted: [{ ...betaMax, behind: [] }], overridden: true },
      }),
    ]);

    expect(text).toContain(`↳ kept ${engine} first: every node after it was busier, or moved behind it by a line above`);
  });

  it('adds nothing to a row contention did not change, or from a Hub predating it', () => {
    const text = logOf([
      routingEntry({ contention: { numCtx: 65_536, demoted: [], overridden: false } }),
      // Contended, gave way to nobody, and not placed on: a pin or affinity put another node first.
      routingEntry({ contention: { numCtx: 65_536, demoted: [{ ...betaMax, behind: [] }], overridden: false } }),
      routingEntry({ contention: null }),
      routingEntry(),
    ]);

    expect(text).not.toContain('↳');
  });
});

describe('hub-pool-cli throughput', () => {
  const FZZY = 'hub-d.example-tailnet.ts.net';
  const deadlineAt46k = { fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 49.8, deadline: true, ageMs: 60_000 };

  function routingEntry(overrides: Partial<PoolRoutingLogResponse['entries'][number]> = {}): PoolRoutingLogResponse['entries'][number] {
    return {
      at: '2026-09-17T10:00:01.000Z',
      direction: 'outbound',
      path: '/v1/chat/completions',
      model: 'qwen3-coder:30b',
      node: PEER_A,
      peerId: 'peer-1',
      backend: 'ollama',
      candidates: 2,
      attempt: 1,
      failedOverFrom: [],
      outcome: 'served',
      status: 200,
      durationMs: 268_000,
      ...overrides,
    };
  }

  function logOf(entries: PoolRoutingLogResponse['entries']): string {
    const summary = { recorded: entries.length, capacity: 200, served: entries.length, failed: 0, failovers: 0, lastAt: '2026-09-17T10:00:01.000Z' };
    return formatPoolRoutingLogLines({ summary, entries }).join('\n');
  }

  const slowFzzy = {
    node: FZZY,
    backend: 'ollama',
    tokensPerSec: 49.8,
    fromPromptTokens: 46_000,
    extrapolated: false,
    predictedMs: 921_000,
    source: 'observed' as const,
    deadline: true,
    slow: true,
  };

  it('marks a routing-log row a measurement changed, with the rate, the prediction and the deadline', () => {
    const text = logOf([routingEntry({ throughput: { estimatedTokens: 46_031, budgetMs: 921_000, estimates: [slowFzzy], overridden: false } })]);

    expect(text).toContain(`~46031-token prompt moved ${FZZY} (~49.8 tok/s, ≥921 s) behind nodes expected to answer within 921 s`);
  });

  it('names the prompt size a reading was taken at when it was read forward to a longer one', () => {
    const readForward = { ...slowFzzy, tokensPerSec: 123, fromPromptTokens: 10_600, extrapolated: true, deadline: false, predictedMs: 1_121_951 };
    const text = logOf([routingEntry({ throughput: { estimatedTokens: 46_031, budgetMs: 921_000, estimates: [readForward], overridden: false } })]);

    expect(text).toContain(`${FZZY} (~123 tok/s measured at ~10600 tokens, ~1122 s)`);
  });

  it('says so when the prompt was placed on a node expected to miss anyway', () => {
    const text = logOf([
      routingEntry({ node: FZZY, throughput: { estimatedTokens: 46_031, budgetMs: 921_000, estimates: [slowFzzy], overridden: true } }),
    ]);

    expect(text).toContain(`placed anyway though ${FZZY} (~49.8 tok/s, ≥921 s) is expected to miss the 921 s deadline`);
    expect(text).not.toContain('moved');
  });

  it('adds nothing to a row no measurement changed, or from a Hub predating throughput', () => {
    const fast = { ...slowFzzy, tokensPerSec: 496, predictedMs: 93_000, deadline: false, slow: false };
    const text = logOf([
      routingEntry({ throughput: { estimatedTokens: 46_031, budgetMs: 921_000, estimates: [fast], overridden: false } }),
      routingEntry({ throughput: null }),
      routingEntry(),
    ]);

    expect(text).not.toContain('token prompt');
  });

  it('lists measured speed per node in status — this node, and each peer as timed here and as reported', () => {
    const base = status({
      peers: [
        peer({
          nodeFqdn: FZZY,
          throughput: {
            observed: [{ model: 'qwen3-coder:30b', backend: 'ollama', prefill: [deadlineAt46k], decode: null }],
            advertised: [
              {
                model: 'qwen3-coder:30b',
                backend: 'ollama',
                prefill: [{ fromTokens: 8_192, promptTokens: 10_600, tokensPerSec: 123, deadline: false, ageMs: 0 }],
                decode: { tokensPerSec: 12, ageMs: 0 },
              },
            ],
          },
        }),
      ],
    });
    const text = formatPoolStatusLines({
      ...base,
      localNode: {
        ...base.localNode,
        throughput: [{ model: 'qwen3.6:27b', backend: 'ollama', prefill: [], decode: { tokensPerSec: 11, ageMs: 0 } }],
      },
    }).join('\n');

    expect(text).toContain('Measured speed');
    expect(text).toMatch(/this node\s+qwen3\.6:27b \(ollama\) output ~11 tok\/s/);
    expect(text).toContain('qwen3-coder:30b (ollama) prompt ≥32k ≤49.8 tok/s (missed deadline)  — timed here');
    expect(text).toContain('qwen3-coder:30b (ollama) prompt ≥8k ~123 tok/s · output ~12 tok/s  — reported');
  });

  it('leaves the status of an unmeasured fleet exactly as it was', () => {
    const base = status({ peers: [peer()] });
    const empty = status({ peers: [peer({ throughput: { observed: [], advertised: [] } })] });

    expect(formatPoolStatusLines({ ...empty, localNode: { ...empty.localNode, throughput: [] } })).toEqual(formatPoolStatusLines(base));
    expect(formatPoolStatusLines(base).join('\n')).not.toContain('Measured speed');
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
