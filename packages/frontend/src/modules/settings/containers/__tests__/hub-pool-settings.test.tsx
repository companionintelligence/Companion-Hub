import { pairPeer, removePeer } from '@/api-client/sdk.gen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubPoolSection } from '../hub-pool-settings';

type Json = Record<string, unknown>;

const fixtures = vi.hoisted(() => ({
  status: {} as Json,
  statusFails: false,
  discoverable: [] as Json[],
  routingLog: { entries: [] as Json[], summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null } } as Json,
  updateSettings: vi.fn(async (_options: { body: Record<string, unknown> }) => ({})),
  peerToggle: vi.fn(async (_options: { url: string }) => ({})),
  patchSettings: vi.fn(async (_options: { url: string; body: Record<string, unknown> }) => ({})),
  pinMint: vi.fn(async (_options: { url: string }) => ({ data: undefined }) as { data?: Record<string, unknown> }),
  pinCancel: vi.fn(async (_options: { url: string }) => ({})),
  upsertPin: vi.fn(async (_options: { body: Record<string, unknown> }) => ({})),
  deletePin: vi.fn(async (_options: { query: Record<string, unknown> }) => ({})),
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
// The per-peer verbs and the two directional switches go through the generated client's low-level
// post/patch until swagger.json and the api-client are regenerated; see hub-pool-settings.tsx.
vi.mock('@/api-client/client.gen', () => ({
  client: {
    // Two different POSTs share this one method, so the fixture dispatches on the URL rather than
    // letting a PIN mint show up in the per-peer toggle's call list.
    post: (options: { url: string }) => (options.url.endsWith('/pairing-pin') ? fixtures.pinMint(options) : fixtures.peerToggle(options)),
    delete: fixtures.pinCancel,
    patch: fixtures.patchSettings,
  },
}));
vi.mock('@/api-client/sdk.gen', () => ({
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
  upsertPoolPin: (options: { body: Record<string, unknown> }) => fixtures.upsertPin(options),
  deletePoolPin: (options: { query: Record<string, unknown> }) => fixtures.deletePin(options),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusQueryKey: () => ['pool-status'],
  poolStatusOptions: () => ({
    queryKey: ['pool-status'],
    queryFn: async () => {
      if (fixtures.statusFails) throw new Error('pool status unreachable');
      return fixtures.status;
    },
  }),
  listDiscoverableQueryKey: () => ['pool-discoverable'],
  listDiscoverableOptions: () => ({ queryKey: ['pool-discoverable'], queryFn: async () => fixtures.discoverable }),
  getPoolRoutingLogQueryKey: () => ['pool-routing-log'],
  getPoolRoutingLogOptions: () => ({ queryKey: ['pool-routing-log'], queryFn: async () => fixtures.routingLog }),
  updatePoolSettingsMutation: () => ({ mutationFn: fixtures.updateSettings }),
}));

const baseStatus = (overrides: Json = {}): Json => ({
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

const connectedPeer = (overrides: Json = {}): Json => ({
  id: 'peer-1',
  nodeFqdn: 'hub-b.example-tailnet.ts.net',
  displayName: 'Studio Hub',
  direction: 'outbound',
  status: 'connected',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: '2026-09-05T10:00:00.000Z',
  lastCapabilities: {
    hardwareTier: 'server',
    backends: [{ type: 'vllm', healthy: true, modelsLoaded: ['llama3.2:3b', 'qwen3:8b'] }],
    updatedAt: '2026-09-05T10:00:00.000Z',
  },
  inFlightRequests: 2,
  ...overrides,
});

/** An inbound request awaiting the operator's confirm — the surface the PIN feeds. */
const pendingInboundPeer = (overrides: Json = {}): Json => ({
  id: 'peer-pending',
  nodeFqdn: 'hub-c.example-tailnet.ts.net',
  displayName: 'Loft Hub',
  direction: 'inbound',
  status: 'pending',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: null,
  lastCapabilities: null,
  inFlightRequests: 0,
  authMode: 'signed',
  ...overrides,
});

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HubPoolSection />
    </QueryClientProvider>,
  );
};

describe('HubPoolSection', () => {
  beforeEach(() => {
    fixtures.status = baseStatus();
    fixtures.statusFails = false;
    fixtures.discoverable = [];
    fixtures.routingLog = { entries: [], summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null } };
    fixtures.updateSettings.mockClear();
    fixtures.peerToggle.mockClear();
    fixtures.patchSettings.mockClear();
    fixtures.pinMint.mockClear();
    fixtures.pinCancel.mockClear();
    fixtures.upsertPin.mockClear();
    fixtures.deletePin.mockClear();
    vi.mocked(pairPeer).mockReset();
    vi.mocked(removePeer).mockClear();
  });

  describe('directional and per-peer kill switches', () => {
    it('PATCHes only its own field, so the other switch is never resent', async () => {
      renderSection();

      await userEvent.click(await screen.findByTestId('hub-pool-inbound-toggle'));

      expect(fixtures.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/api/inference/pool/settings', body: { poolInboundEnabled: false } }),
      );
    });

    it('locks one direction to its own .env variable without touching the other', async () => {
      fixtures.status = baseStatus({
        directions: { outbound: { enabled: false, disabledBy: 'env' }, inbound: { enabled: true, disabledBy: null } },
        reason: 'partially_disabled',
        routingActive: false,
      });

      renderSection();

      // Named per direction: an operator told to edit the wrong variable goes looking in the right
      // file for the wrong line.
      expect(await screen.findByText('HUB_POOL_OUTBOUND_ENV_LOCKED')).toBeTruthy();
      expect((screen.getByTestId('hub-pool-outbound-toggle') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('hub-pool-inbound-toggle') as HTMLInputElement).disabled).toBe(false);
    });

    it('disables both directions when the master switch is off, since neither can do anything', async () => {
      fixtures.status = baseStatus({
        enabled: false,
        disabledBy: 'setting',
        reason: 'disabled_by_setting',
        routingActive: false,
        directions: { outbound: { enabled: false, disabledBy: 'setting' }, inbound: { enabled: false, disabledBy: 'setting' } },
        settings: { poolEnabled: false, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      });

      renderSection();

      await waitFor(() => expect((screen.getByTestId('hub-pool-outbound-toggle') as HTMLInputElement).disabled).toBe(true));
      expect((screen.getByTestId('hub-pool-inbound-toggle') as HTMLInputElement).disabled).toBe(true);
    });

    it('explains a partly disabled pool rather than claiming it is active', async () => {
      fixtures.status = baseStatus({ reason: 'partially_disabled' });

      renderSection();

      const state = await screen.findByTestId('hub-pool-state');
      expect(state.getAttribute('data-reason')).toBe('partially_disabled');
      expect(state.textContent).toBe('HUB_POOL_REASON_PARTIAL');
    });

    it('takes one peer out of the pool by id, without the unpair confirmation', async () => {
      fixtures.status = baseStatus({ peers: [connectedPeer()], peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 } });

      renderSection();

      await userEvent.click(await screen.findByTestId('hub-pool-peer-toggle'));

      expect(fixtures.peerToggle).toHaveBeenCalledWith({ url: '/api/inference/pool/peers/peer-1/disable' });
    });

    it('never renders a disabled peer as connected', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer({ enabled: false })],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 1 },
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-peer-disabled-badge')).toBeTruthy();
      expect(screen.queryByText('HUB_POOL_STATUS_CONNECTED')).toBeNull();
    });

    it('says a peer is refusing OUR work rather than showing it as a node with no models', async () => {
      fixtures.status = baseStatus({
        peers: [
          connectedPeer({
            lastCapabilities: { hardwareTier: 'server', backends: [], acceptingWork: false, updatedAt: '2026-09-05T10:00:00.000Z' },
          }),
        ],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-peer-not-accepting')).toBeTruthy();
    });

    it('marks a peer still on the legacy bearer token, since that is what blocks poolRequireSignedPeers', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer({ authMode: 'bearer' })],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-peer-bearer')).toBeTruthy();
    });

    it('does not mark a peer that has upgraded to a pinned key', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer({ authMode: 'signed' })],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-peer')).toBeTruthy();
      expect(screen.queryByTestId('hub-pool-peer-bearer')).toBeNull();
    });

    it('reads a peer on a build predating pinned identities as not yet upgraded, never as signed', async () => {
      // `authMode` is absent on such a peer. Treating absence as signed would hide the one peer that
      // would actually be cut off by turning the switch on.
      fixtures.status = baseStatus({
        peers: [connectedPeer({ authMode: undefined })],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-peer-bearer')).toBeTruthy();
    });
  });

  it('explains that pooling is on but idle when nothing is paired', async () => {
    fixtures.status = baseStatus({ reason: 'no_peers', routingActive: false });

    renderSection();

    const state = await screen.findByTestId('hub-pool-state');
    expect(state.getAttribute('data-reason')).toBe('no_peers');
    expect(state.textContent).toBe('HUB_POOL_REASON_NO_PEERS');
    expect(screen.getByText('HUB_POOL_STATE_LOCAL_ONLY')).toBeTruthy();
    expect(screen.getByText('HUB_POOL_CONNECTED_EMPTY')).toBeTruthy();
    expect(screen.queryByTestId('hub-pool-env-lock')).toBeNull();
  });

  it('marks the env kill switch as non-actionable and locks the toggle', async () => {
    fixtures.status = baseStatus({
      enabled: false,
      disabledBy: 'env',
      reason: 'disabled_by_env',
      routingActive: false,
      settings: {
        poolEnabled: true,
        poolOutboundEnabled: true,
        poolInboundEnabled: true,
        poolLocalAffinity: 1,
        poolHealthPollSeconds: 30,
        poolRequireSignedPeers: false,
      },
    });

    renderSection();

    await waitFor(() => expect(screen.getByTestId('hub-pool-env-lock')).toBeTruthy());
    expect(screen.getByText('HUB_POOL_ENV_LOCK_HINT')).toBeTruthy();
    expect(screen.getByText('HUB_POOL_TOGGLE_ENV_LOCKED')).toBeTruthy();
    // The setting still reads "on" — only the .env is holding pooling down, and the toggle must not
    // pretend it can lift it.
    expect((screen.getByTestId('hub-pool-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a PATCH when the operator flips the pool toggle', async () => {
    renderSection();

    const toggle = await screen.findByTestId('hub-pool-toggle');
    await userEvent.click(toggle);

    await waitFor(() => expect(fixtures.updateSettings).toHaveBeenCalledTimes(1));
    expect(fixtures.updateSettings.mock.calls[0]?.[0]).toMatchObject({ body: { poolEnabled: false } });
  });

  it('saves the tuning inputs together, clamped to the range the backend accepts', async () => {
    renderSection();

    const affinity = await screen.findByTestId('hub-pool-affinity-input');
    await userEvent.clear(affinity);
    await userEvent.type(affinity, '40');

    await userEvent.click(screen.getByTestId('hub-pool-settings-save'));

    await waitFor(() => expect(fixtures.updateSettings).toHaveBeenCalledTimes(1));
    expect(fixtures.updateSettings.mock.calls[0]?.[0]).toMatchObject({ body: { poolLocalAffinity: 20, poolHealthPollSeconds: 30 } });
  });

  it('tells the operator an unreachable peer heals itself instead of needing an unpair', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer({ status: 'unreachable', consecutiveFailures: 3, inFlightRequests: 0 })],
      peerCounts: { total: 1, connected: 0, pending: 0, unreachable: 1 },
      reason: 'no_peers',
      routingActive: false,
    });

    renderSection();

    const hint = await screen.findByTestId('hub-pool-unreachable-hint');
    expect(hint.textContent).toBe('HUB_POOL_UNREACHABLE_HINT');
    expect(screen.getByText('HUB_POOL_STATUS_UNREACHABLE')).toBeTruthy();
    // An unreachable peer's cached inventory is not capacity the pool can offer right now, so only
    // this node's own model is listed as servable.
    expect(screen.getAllByTestId('hub-pool-model').map((row) => row.getAttribute('data-model'))).toEqual(['llama3.2:3b']);
    expect(screen.getAllByTestId('hub-pool-model').map((row) => row.getAttribute('data-nodes'))).toEqual(['HUB_POOL_LOCAL_NODE_LABEL']);
    const cell = screen.getAllByTestId('hub-pool-model')[0]?.querySelector('td[headers]');
    expect(cell?.textContent).toContain('HUB_POOL_MODELS_ONLY_HERE');
    expect(cell?.getAttribute('headers')).toBe('hub-pool-model-col-0');
  });

  it('shows a distinct "needs re-pair" badge and the backend\'s exact remedy for an identity-changed peer, never the self-heals hint', async () => {
    fixtures.status = baseStatus({
      peers: [
        connectedPeer({
          status: 'unreachable',
          consecutiveFailures: 5,
          inFlightRequests: 0,
          probeFailure: {
            kind: 'identity_changed',
            action:
              'hub-b.example-tailnet.ts.net is now a different Hub Pool identity than the one paired here, so its Hub database was probably recreated. This Hub will not trust the new key by itself. Re-pair: (1) here: cihub pool unpair hub-b.example-tailnet.ts.net; ...',
          },
        }),
      ],
      peerCounts: { total: 1, connected: 0, pending: 0, unreachable: 1 },
      reason: 'no_peers',
      routingActive: false,
    });

    renderSection();

    expect(await screen.findByTestId('hub-pool-peer-needs-repair-badge')).toBeTruthy();
    expect(screen.getByText('HUB_POOL_STATUS_NEEDS_REPAIR')).toBeTruthy();
    // Never the generic "Unreachable" label, and never the misleading self-heals copy: this pairing
    // will not rejoin on its own, however many more probes run.
    expect(screen.queryByText('HUB_POOL_STATUS_UNREACHABLE')).toBeNull();
    expect(screen.queryByTestId('hub-pool-unreachable-hint')).toBeNull();
    const hint = await screen.findByTestId('hub-pool-peer-needs-repair-hint');
    expect(hint.textContent).toContain('cihub pool unpair hub-b.example-tailnet.ts.net');
  });

  it('still uses the generic self-heals hint for a plain unreachable peer with no probeFailure (older cached payload)', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer({ status: 'unreachable', consecutiveFailures: 2, inFlightRequests: 0, probeFailure: null })],
      peerCounts: { total: 1, connected: 0, pending: 0, unreachable: 1 },
      reason: 'no_peers',
      routingActive: false,
    });

    renderSection();

    expect(await screen.findByTestId('hub-pool-unreachable-hint')).toBeTruthy();
    expect(screen.queryByTestId('hub-pool-peer-needs-repair-badge')).toBeNull();
    expect(screen.queryByTestId('hub-pool-peer-needs-repair-hint')).toBeNull();
  });

  it('merges the model inventory across the pool and names every node holding each model', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer()],
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    });

    renderSection();

    const rows = await screen.findAllByTestId('hub-pool-model');

    // Attributes, not textContent: presence is rendered as a dot per node column, so the
    // set of nodes holding a model is not readable as text — and asserting on concatenated
    // glyphs was how this test previously encoded the old chip layout.
    expect(rows.map((row) => row.getAttribute('data-model'))).toEqual(['llama3.2:3b', 'qwen3:8b']);
    expect(rows.map((row) => row.getAttribute('data-nodes'))).toEqual(['HUB_POOL_LOCAL_NODE_LABEL,Studio Hub', 'Studio Hub']);
  });

  it('renders a failover as one entry carrying the chain of nodes that were tried', async () => {
    fixtures.routingLog = {
      entries: [
        {
          at: '2026-09-05T10:05:00.000Z',
          direction: 'outbound',
          path: '/v1/chat/completions',
          model: 'llama3.2:3b',
          node: 'hub-b.example-tailnet.ts.net',
          peerId: 'peer-1',
          backend: 'vllm',
          candidates: 2,
          attempt: 2,
          failedOverFrom: ['local'],
          outcome: 'served',
          status: 200,
          durationMs: 412,
        },
        {
          at: '2026-09-05T10:04:00.000Z',
          direction: 'inbound',
          path: '/api/chat',
          model: null,
          node: 'hub-b.example-tailnet.ts.net',
          peerId: 'peer-1',
          backend: 'ollama',
          candidates: 1,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'served',
          status: 200,
          durationMs: 88,
        },
      ],
      summary: { recorded: 2, capacity: 200, served: 2, failed: 0, failovers: 1, lastAt: '2026-09-05T10:05:00.000Z' },
    };

    renderSection();

    const entries = await screen.findAllByTestId('hub-pool-routing-entry');
    expect(entries).toHaveLength(2);
    const failovers = screen.getAllByTestId('hub-pool-routing-failover');
    expect(failovers).toHaveLength(1);

    // The CHAIN is the fact, not the label. It moved onto the marker's title and the row's
    // data attribute when the log became a table, so assert on the chain rather than on the
    // badge's glyph — which is what the old textContent check was really standing in for.
    expect(failovers[0]?.getAttribute('title')).toBe('HUB_POOL_ROUTING_FAILOVER');
    const failedOverRow = entries.find((row) => row.getAttribute('data-failedover'));
    expect(failedOverRow?.getAttribute('data-failedover')).toBe('local');
    expect(screen.getByText('HUB_POOL_ROUTING_INBOUND')).toBeTruthy();
  });

  /**
   * The dashboard settles a row through `settledOutcome`/`isRefused`; this table read `outcome` raw.
   * A Hub built before refusals settled `failed` still writes `served` for a relayed 4xx (core-2,
   * 2026-09-29: six `served` rows with status 400, each a ~5 ms refusal), and here those read as
   * served in a few milliseconds while the dashboard, reading the same log, called them refused.
   */
  it('settles each routing row the way the dashboard does: a refusal is not served, whatever an older Hub wrote', async () => {
    const row = (overrides: Json): Json => ({
      at: '2026-09-29T10:05:00.000Z',
      direction: 'outbound',
      path: '/v1/chat/completions',
      model: 'gemma3:1b',
      node: 'local',
      peerId: null,
      backend: 'ollama',
      candidates: 1,
      attempt: 1,
      failedOverFrom: [],
      durationMs: 5,
      ...overrides,
    });
    fixtures.routingLog = {
      entries: [
        // An older Hub's refusal: `served`, with the engine's 400.
        row({ outcome: 'served', status: 400 }),
        // This build's: `failed`, with the verdict named.
        row({ outcome: 'failed', status: 500, requestError: { signature: 'no-user-query', basis: 'definitive', confirms: null } }),
        row({ outcome: 'served', status: 200, durationMs: 412 }),
        row({ outcome: 'pending', status: null, durationMs: null }),
        row({ outcome: 'failed', status: null, node: null }),
      ],
      summary: { recorded: 5, capacity: 200, served: 2, failed: 2, failovers: 0, lastAt: '2026-09-29T10:05:00.000Z' },
    };

    renderSection();

    const entries = await screen.findAllByTestId('hub-pool-routing-entry');
    expect(entries.map((entry) => entry.getAttribute('data-outcome'))).toEqual(['failed', 'failed', 'served', 'pending', 'failed']);
    expect(entries.map((entry) => entry.getAttribute('data-refused'))).toEqual(['400', '500', null, null, null]);
    expect(screen.getAllByTestId('hub-pool-routing-refused')).toHaveLength(2);
    expect(screen.getAllByText('HUB_POOL_ROUTING_DURATION')).toHaveLength(1);
    expect(screen.getAllByText('HUB_POOL_ROUTING_PENDING_LABEL')).toHaveLength(1);
    expect(screen.getAllByText('HUB_POOL_ROUTING_FAILED_LABEL')).toHaveLength(1);
  });

  /**
   * core-2, 2026-09-29: its engine answered gemma4 turns 200 with `<unused49>` tokens. Those rows now
   * carry `requestError.basis: 'node'`, and this table must say the node failed — never "refused",
   * which tells the operator to fix the app's request, and never "no node served this".
   */
  it('names a node’s bad output as the node’s fault, not a refusal, and says why each failed-over node was passed', async () => {
    const row = (overrides: Json): Json => ({
      at: '2026-09-29T10:05:00.000Z',
      direction: 'outbound',
      path: '/api/chat',
      model: 'gemma4:e4b',
      node: 'local',
      peerId: null,
      backend: 'ollama',
      candidates: 2,
      attempt: 1,
      failedOverFrom: [],
      durationMs: 900,
      ...overrides,
    });
    fixtures.routingLog = {
      entries: [
        row({
          outcome: 'failed',
          status: 200,
          requestError: { signature: 'degenerate-output', basis: 'node', confirms: null },
          reason: 'degenerate-output',
        }),
        row({
          outcome: 'failed',
          status: 200,
          requestError: { signature: 'truncated-upstream', basis: 'node', confirms: null },
          reason: 'truncated-upstream',
        }),
        row({
          outcome: 'served',
          status: 200,
          node: 'core-17.tailxyz.ts.net',
          attempt: 2,
          failedOverFrom: ['local'],
          attempts: [{ node: 'local', backend: 'ollama', status: 200, reason: 'truncated-upstream' }],
        }),
      ],
      summary: { recorded: 3, capacity: 200, served: 1, failed: 2, failovers: 1, lastAt: '2026-09-29T10:05:00.000Z' },
    };

    renderSection();

    const entries = await screen.findAllByTestId('hub-pool-routing-entry');
    expect(entries.map((entry) => entry.getAttribute('data-outcome'))).toEqual(['failed', 'failed', 'served']);
    expect(entries.map((entry) => entry.getAttribute('data-badoutput'))).toEqual(['degenerate-output', 'truncated-upstream', null]);
    expect(screen.queryAllByTestId('hub-pool-routing-refused')).toHaveLength(0);
    expect(screen.getAllByTestId('hub-pool-routing-bad-output').map((cell) => cell.textContent)).toEqual([
      'HUB_POOL_ROUTING_DEGENERATE_LABEL',
      'HUB_POOL_ROUTING_TRUNCATED_LABEL',
    ]);
    expect(screen.getByTestId('hub-pool-routing-failover').getAttribute('title')).toBe('HUB_POOL_ROUTING_FAILOVER');
  });

  describe('prefix affinity', () => {
    const withAffinity = (poolPrefixAffinityMaxInFlight: number, poolPrefixAffinityMargin: number): Json =>
      baseStatus({
        settings: {
          poolEnabled: true,
          poolOutboundEnabled: true,
          poolInboundEnabled: true,
          poolLocalAffinity: 1,
          poolHealthPollSeconds: 30,
          poolPrefixAffinityMaxInFlight,
          poolPrefixAffinityMargin,
        },
      });

    /** beta-max, 2026-09-29: margin 3 accepted at limit 0, and nothing anywhere said it did nothing. */
    it('says a margin set while the limit is 0 has no effect', async () => {
      fixtures.status = withAffinity(0, 3);

      renderSection();

      const note = await screen.findByTestId('hub-pool-prefix-affinity');
      expect(note.getAttribute('data-margin-active')).toBe('false');
      expect(note.textContent).toBe('HUB_POOL_PREFIX_AFFINITY_MARGIN_INACTIVE');
    });

    it('states the limit, and the margin when one is set, while affinity is on', async () => {
      fixtures.status = withAffinity(2, 1);
      const { unmount } = renderSection();

      const withMargin = await screen.findByTestId('hub-pool-prefix-affinity');
      expect(withMargin.getAttribute('data-margin-active')).toBe('true');
      expect(withMargin.textContent).toBe('HUB_POOL_PREFIX_AFFINITY_ON_MARGIN');
      unmount();

      fixtures.status = withAffinity(2, 0);
      renderSection();

      const limitOnly = await screen.findByTestId('hub-pool-prefix-affinity');
      expect(limitOnly.getAttribute('data-margin-active')).toBe('false');
      expect(limitOnly.textContent).toBe('HUB_POOL_PREFIX_AFFINITY_ON');
    });

    it('says nothing at the defaults, or from a Hub predating either setting', async () => {
      fixtures.status = withAffinity(0, 0);
      const { unmount } = renderSection();
      await screen.findByTestId('hub-pool-settings-save');
      expect(screen.queryByTestId('hub-pool-prefix-affinity')).toBeNull();
      unmount();

      fixtures.status = baseStatus();
      renderSection();
      await screen.findByTestId('hub-pool-settings-save');
      expect(screen.queryByTestId('hub-pool-prefix-affinity')).toBeNull();
    });
  });

  describe('LAN discovery (mDNS)', () => {
    it('renders off when the setting is absent, and PATCHes only its own field when switched on', async () => {
      renderSection();

      const toggle = await screen.findByTestId('hub-pool-mdns-toggle');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      await userEvent.click(toggle);

      await waitFor(() => expect(fixtures.updateSettings).toHaveBeenCalledTimes(1));
      expect(fixtures.updateSettings.mock.calls[0]?.[0]).toEqual({ body: { poolMdnsEnabled: true } });
    });

    it('says in its help that it needs host networking', async () => {
      renderSection();

      await screen.findByTestId('hub-pool-mdns-toggle');
      expect(screen.getByText('HUB_POOL_MDNS_LABEL')).toBeTruthy();
      // The text itself is in the translation file; this pins that the switch carries it.
      expect(document.querySelector('.field-hint-hub-pool-mdns')).toBeTruthy();
    });

    it('is disabled while pooling is off, since mDNS only runs with the pool', async () => {
      fixtures.status = baseStatus({
        enabled: false,
        disabledBy: 'setting',
        reason: 'disabled_by_setting',
        routingActive: false,
        settings: {
          poolEnabled: false,
          poolOutboundEnabled: true,
          poolInboundEnabled: true,
          poolLocalAffinity: 1,
          poolHealthPollSeconds: 30,
          poolMdnsEnabled: true,
        },
      });
      renderSection();

      expect((await screen.findByTestId('hub-pool-mdns-toggle')).hasAttribute('disabled')).toBe(true);
    });

    it('lists an unverified LAN row without a Pair button, and keeps Pair on attested rows', async () => {
      fixtures.discoverable = [
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'hub-b.example-tailnet.ts.net', hostname: 'hub-b' },
        // What this build sends, and what the build that introduced mDNS sent (no `verified` at all).
        { tailscaleDeviceId: '', nodeFqdn: 'core-9.local', hostname: 'core-9', source: 'mdns', verified: false, address: '172.18.0.66:5002' },
        { tailscaleDeviceId: '', nodeFqdn: 'core-9.tailxyz.ts.net', hostname: 'lookalike', source: 'mdns', address: '172.18.0.67:5002' },
      ];
      renderSection();

      await waitFor(() => expect(screen.getAllByTestId('hub-pool-discoverable-unverified')).toHaveLength(2));
      expect(screen.getAllByRole('button', { name: 'HUB_POOL_PAIR_BUTTON' })).toHaveLength(1);
      expect(screen.getByText('172.18.0.66:5002')).toBeTruthy();
      expect(screen.getAllByText('HUB_POOL_DISCOVERABLE_UNVERIFIED')).toHaveLength(2);
    });
  });

  it('names the missing tailnet-enumeration credential instead of showing a bare empty device list', async () => {
    fixtures.status = baseStatus({ tailscaleAdminApiConfigured: false, reason: 'no_peers', routingActive: false });

    renderSection();

    await waitFor(() => expect(screen.getByTestId('hub-pool-discovery-unconfigured')).toBeTruthy());
    expect(screen.queryByText('HUB_POOL_DISCOVERABLE_EMPTY')).toBeNull();
  });

  it('shows the requester FQDN on a pending inbound request, not just its self-chosen display name', async () => {
    fixtures.status = baseStatus({
      reason: 'no_peers',
      routingActive: false,
      peers: [
        connectedPeer({
          id: 'inbound-1',
          nodeFqdn: 'attacker-box.example-tailnet.ts.net',
          // A pairing request is unauthenticated, so the display name is whatever the caller sent.
          displayName: "Liam's MacBook",
          direction: 'inbound',
          status: 'pending',
          lastCapabilities: null,
        }),
      ],
      peerCounts: { total: 1, connected: 0, pending: 1, unreachable: 0 },
    });

    renderSection();

    const fqdn = await screen.findByTestId('hub-pool-pending-fqdn');
    expect(fqdn.textContent).toBe('attacker-box.example-tailnet.ts.net');
    expect(screen.getByText("Liam's MacBook")).toBeTruthy();
  });

  // Nothing sweeps outbound pending rows and discovery hides an FQDN already in the peer table, so
  // without this button a peer that never answers is stuck on the page and unpairable except by CLI.
  it('lets the operator cancel an outbound request the other Hub never answered', async () => {
    fixtures.status = baseStatus({
      reason: 'no_peers',
      routingActive: false,
      peers: [
        connectedPeer({ id: 'outbound-1', direction: 'outbound', status: 'pending', lastSeenAt: null, lastCapabilities: null, inFlightRequests: 0 }),
      ],
      peerCounts: { total: 1, connected: 0, pending: 1, unreachable: 0 },
    });

    renderSection();

    const row = await screen.findByTestId('hub-pool-pending-outbound');
    expect(row.textContent).toContain('HUB_POOL_OUTBOUND_WAITING');

    await userEvent.click(screen.getByTestId('hub-pool-cancel-request-btn'));

    await waitFor(() => expect(vi.mocked(removePeer)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(removePeer).mock.calls[0]?.[0]).toMatchObject({ path: { id: 'outbound-1' } });
  });

  it('holds an unpair behind a confirmation dialog because it revokes both tokens', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer()],
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    });

    renderSection();

    await userEvent.click(await screen.findByTestId('hub-pool-unpair-btn'));
    // The click opens the dialog and nothing else — the peer is still paired at this point.
    expect(vi.mocked(removePeer)).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId('hub-pool-unpair-confirm-btn');
    expect(screen.getByText('HUB_POOL_UNPAIR_CONFIRM')).toBeTruthy();

    await userEvent.click(confirm);

    await waitFor(() => expect(vi.mocked(removePeer)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(removePeer).mock.calls[0]?.[0]).toMatchObject({ path: { id: 'peer-1' } });
  });

  // react-query v5 leaves an errored query with `isPending` false and `data` undefined, so a
  // skeleton keyed off "no data" would never clear.
  it('explains a failed status fetch instead of showing the skeleton forever', async () => {
    fixtures.statusFails = true;

    renderSection();

    const error = await screen.findByTestId('hub-pool-status-error');
    expect(error.textContent).toBe('HUB_POOL_STATUS_ERROR');
    expect(screen.queryByTestId('hub-pool-state')).toBeNull();
  });

  describe('pairing PIN and peer identity', () => {
    const pairable = () => {
      fixtures.discoverable = [{ tailscaleDeviceId: 'ts-1', nodeFqdn: 'hub-b.example-tailnet.ts.net', hostname: 'hub-b' }];
    };

    it('keeps a short PIN on the field and does not pair', async () => {
      pairable();
      renderSection();

      await userEvent.type(await screen.findByTestId('hub-pool-pin-input'), '12345');
      await userEvent.click(screen.getByRole('button', { name: 'HUB_POOL_PAIR_BUTTON' }));

      expect(screen.getByText('HUB_POOL_PIN_INPUT_INVALID')).toBeTruthy();
      expect(vi.mocked(pairPeer)).not.toHaveBeenCalled();
    });

    it('sends a six-digit PIN with the Hub being paired', async () => {
      pairable();
      vi.mocked(pairPeer).mockResolvedValue({} as never);
      renderSection();

      await userEvent.type(await screen.findByTestId('hub-pool-pin-input'), '481502');
      await userEvent.click(screen.getByRole('button', { name: 'HUB_POOL_PAIR_BUTTON' }));

      await waitFor(() => expect(vi.mocked(pairPeer)).toHaveBeenCalledTimes(1));
      expect(vi.mocked(pairPeer).mock.calls[0]?.[0]).toMatchObject({
        body: { nodeFqdn: 'hub-b.example-tailnet.ts.net', pin: '481502' },
      });
    });

    it('pairs with no PIN when the field is left blank', async () => {
      pairable();
      vi.mocked(pairPeer).mockResolvedValue({} as never);
      renderSection();

      await userEvent.click(await screen.findByRole('button', { name: 'HUB_POOL_PAIR_BUTTON' }));

      await waitFor(() => expect(vi.mocked(pairPeer)).toHaveBeenCalledTimes(1));
      expect(vi.mocked(pairPeer).mock.calls[0]?.[0]).toMatchObject({ body: { nodeFqdn: 'hub-b.example-tailnet.ts.net' } });
      expect(vi.mocked(pairPeer).mock.calls[0]?.[0]?.body).not.toHaveProperty('pin');
    });

    it('renders the digits once, straight from the mint response and never from status', async () => {
      fixtures.status = baseStatus();
      fixtures.pinMint.mockResolvedValueOnce({ data: { pin: '481502', expiresAt: '2099-01-01T00:10:00.000Z' } });
      renderSection();
      await screen.findByTestId('hub-pool-mint-pin-btn');

      await userEvent.click(screen.getByTestId('hub-pool-mint-pin-btn'));

      expect(await screen.findByTestId('hub-pool-minted-pin')).toHaveTextContent('481502');
      expect(screen.getByTestId('hub-pool-minted-pin-expiry')).toHaveAttribute('datetime', '2099-01-01T00:10:00.000Z');
      expect(fixtures.pinMint).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/inference/pool/pairing-pin' }));
    });

    it('takes the digits off the screen once the PIN has expired', async () => {
      fixtures.status = baseStatus();
      fixtures.pinMint.mockImplementation(async () => ({
        data: { pin: '481502', expiresAt: new Date(Date.now() + 150).toISOString() },
      }));
      renderSection();

      await userEvent.click(await screen.findByTestId('hub-pool-mint-pin-btn'));

      expect(await screen.findByTestId('hub-pool-minted-pin')).toHaveTextContent('481502');
      await waitFor(() => expect(screen.queryByTestId('hub-pool-minted-pin')).not.toBeInTheDocument(), { timeout: 2000 });
    });

    it('says a PIN is outstanding without ever re-showing it, which is what status reports', async () => {
      // `GET status` carries `{ active, expiresAt }` and never the value, so a page reload — or any
      // other operator polling the same endpoint — cannot recover a PIN it did not mint.
      fixtures.status = baseStatus({ pairingPin: { active: true, expiresAt: '2099-01-01T00:10:00.000Z' } });
      renderSection();

      expect(await screen.findByTestId('hub-pool-pin-state')).toHaveTextContent('HUB_POOL_PIN_ACTIVE_ELSEWHERE');
      expect(screen.getByTestId('hub-pool-pin-expiry')).toHaveAttribute('datetime', '2099-01-01T00:10:00.000Z');
      expect(screen.queryByTestId('hub-pool-minted-pin')).not.toBeInTheDocument();
    });

    it('does not keep a dead PIN on screen after its expiry', async () => {
      fixtures.status = baseStatus({ pairingPin: { active: true, expiresAt: '2020-01-01T00:10:00.000Z' } });
      renderSection();

      expect(await screen.findByTestId('hub-pool-pin-state')).toHaveTextContent('HUB_POOL_PIN_NONE');
      expect(screen.queryByTestId('hub-pool-pin-expiry')).not.toBeInTheDocument();
    });

    it('shows the requester’s key fingerprint on the confirm row, next to its FQDN', async () => {
      // Q3: the PIN gets the identity pinned; the operator still confirms, and confirming needs
      // both halves — the name it claims and the key it will actually authenticate with.
      fixtures.status = baseStatus({
        peers: [pendingInboundPeer({ peerKeyFingerprint: 'aa:bb:cc:dd:ee:ff:00:11' })],
        peerCounts: { total: 1, connected: 0, pending: 1, unreachable: 0, disabled: 0 },
      });
      renderSection();

      expect(await screen.findByTestId('hub-pool-pending-fqdn')).toHaveTextContent('hub-c.example-tailnet.ts.net');
      expect(screen.getByTestId('hub-pool-pending-fingerprint')).toHaveTextContent('HUB_POOL_PEER_FINGERPRINT');
    });

    it('marks a request that arrived without a PIN as an unverified claim', async () => {
      fixtures.status = baseStatus({
        peers: [pendingInboundPeer({ peerKeyFingerprint: null })],
        peerCounts: { total: 1, connected: 0, pending: 1, unreachable: 0, disabled: 0 },
      });
      renderSection();

      expect(await screen.findByTestId('hub-pool-pending-fingerprint')).toHaveTextContent('HUB_POOL_PEER_FINGERPRINT_UNVERIFIED');
    });

    it('surfaces an unusable identity the way a down backend is surfaced, rather than hiding it', async () => {
      fixtures.status = baseStatus({
        localNode: {
          ...(baseStatus().localNode as Json),
          identity: { nodeUuid: 'self-uuid', publicKeyFingerprint: null, identityError: 'stored pool private key could not be decrypted' },
        },
      });
      renderSection();

      expect(await screen.findByTestId('hub-pool-identity-error')).toHaveTextContent('HUB_POOL_IDENTITY_ERROR');
      expect(screen.queryByTestId('hub-pool-local-fingerprint')).not.toBeInTheDocument();
    });
  });

  /**
   * Routing pins. The card's job is not the mutation — it is making a pin that has quietly stopped
   * applying visible, because a `prefer` pin never errors anywhere else.
   */
  describe('routing pins', () => {
    it('says nothing is pinned when nothing is, on a Hub with no peers at all', async () => {
      renderSection();

      expect(await screen.findByText('HUB_POOL_PINS_EMPTY')).toBeTruthy();
      expect(screen.queryByTestId('hub-pool-pin')).toBeNull();
    });

    it('renders a stored pin with the model it covers and the node it names', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer()],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
        pins: [
          {
            scope: 'model',
            model: 'llama3.2:3b',
            targetKind: 'peer',
            peerId: 'peer-1',
            mode: 'prefer',
            nodeFqdn: 'hub-b.example-tailnet.ts.net',
            targetAvailable: true,
          },
        ],
      });

      renderSection();

      const row = await screen.findByTestId('hub-pool-pin');
      expect(row.textContent).toContain('llama3.2:3b');
      expect(row.textContent).toContain('hub-b.example-tailnet.ts.net');
      expect(screen.queryByTestId('hub-pool-pin-unavailable')).toBeNull();
    });

    it('warns on a pin whose node cannot take work right now, which is the only place that shows', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer({ status: 'unreachable' })],
        peerCounts: { total: 1, connected: 0, pending: 0, unreachable: 1, disabled: 0 },
        pins: [
          {
            scope: 'default',
            targetKind: 'peer',
            peerId: 'peer-1',
            mode: 'prefer',
            nodeFqdn: 'hub-b.example-tailnet.ts.net',
            targetAvailable: false,
          },
        ],
      });

      renderSection();

      expect(await screen.findByTestId('hub-pool-pin-unavailable')).toBeTruthy();
    });

    it('names an unpaired target rather than showing a bare peer id', async () => {
      fixtures.status = baseStatus({
        pins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-gone', mode: 'prefer', nodeFqdn: null, targetAvailable: false }],
      });

      renderSection();

      expect(await screen.findByText('HUB_POOL_PINS_UNPAIRED')).toBeTruthy();
    });

    it('pins to this Hub for every model by default, which is the pool-wide pin', async () => {
      renderSection();

      await userEvent.click(await screen.findByTestId('hub-pool-pin-add'));

      expect(fixtures.upsertPin).toHaveBeenCalledWith({ body: { scope: 'default', targetKind: 'local' } });
    });

    it('removes a pin by scope and model, never by an id it does not have', async () => {
      fixtures.status = baseStatus({
        pins: [{ scope: 'model', model: 'hf.co/org/repo:Q4_K_M', targetKind: 'local', mode: 'prefer', nodeFqdn: null, targetAvailable: true }],
      });

      renderSection();
      await userEvent.click(await screen.findByTestId('hub-pool-pin-remove'));

      expect(fixtures.deletePin).toHaveBeenCalledWith({ query: { scope: 'model', model: 'hf.co/org/repo:Q4_K_M' } });
    });

    it('warns in the unpair dialog when a pin points at the peer being unpaired', async () => {
      fixtures.status = baseStatus({
        peers: [connectedPeer()],
        peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0, disabled: 0 },
        pins: [
          { scope: 'default', targetKind: 'peer', peerId: 'peer-1', mode: 'prefer', nodeFqdn: 'hub-b.example-tailnet.ts.net', targetAvailable: true },
        ],
      });

      renderSection();
      await userEvent.click(await screen.findByTestId('hub-pool-unpair-btn'));

      expect(await screen.findByTestId('hub-pool-unpair-pins-warning')).toBeTruthy();
    });

    it('marks a routing-log entry a pin shaped, and leaves the others unmarked', async () => {
      fixtures.routingLog = {
        entries: [
          {
            at: '2026-09-05T10:00:01.000Z',
            direction: 'outbound',
            path: '/v1/chat/completions',
            model: 'llama3.2:3b',
            node: 'hub-b.example-tailnet.ts.net',
            peerId: 'peer-1',
            backend: 'vllm',
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
        summary: { recorded: 2, capacity: 200, served: 2, failed: 0, failovers: 0, lastAt: '2026-09-05T10:00:01.000Z' },
      };

      renderSection();

      await waitFor(() => expect(screen.getAllByTestId('hub-pool-routing-entry')).toHaveLength(2));
      expect(screen.getAllByTestId('hub-pool-routing-pinned')).toHaveLength(1);
    });
  });

  // A peer whose capabilities probe has not landed yet has no `inFlightRequests`. This
  // rendered as the literal word "undefined" in the queue cell, and must not silently
  // become 0 either — an idle peer and an unread counter mean different things.
  it('shows an unread peer queue as unknown, never as "undefined" or 0', async () => {
    fixtures.status = baseStatus({ peers: [connectedPeer({ inFlightRequests: undefined })] });

    renderSection();

    await waitFor(() => expect(screen.getByTestId('hub-pool-card')).toBeTruthy());
    expect(screen.queryByText('undefined')).toBeNull();
    expect(screen.getAllByText('COMMON_UNKNOWN').length).toBeGreaterThan(0);
  });

  // The matrix exists to make this visible. A model only one node can serve disappears
  // when that node does, and the old chip list required counting pills across thirty rows
  // to notice. It is marked on the row AND counted on the collapsed summary.
  it('marks a model only one node can serve, and counts them on the summary', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer()],
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    });

    renderSection();

    const rows = await screen.findAllByTestId('hub-pool-model');
    const soleSourced = rows.filter((row) => (row.getAttribute('data-nodes') ?? '').split(',').length === 1);

    // qwen3:8b lives only on the peer; llama3.2:3b is on both.
    expect(soleSourced.map((row) => row.getAttribute('data-model'))).toEqual(['qwen3:8b']);
    expect(screen.getByText('HUB_POOL_MODELS_SOLE_SOURCED')).toBeTruthy();
  });

  it('filters the matrix without touching what the pool does', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer()],
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    });

    renderSection();
    await screen.findAllByTestId('hub-pool-model');

    await userEvent.type(screen.getByTestId('hub-pool-model-filter'), 'qwen');

    await waitFor(() => expect(screen.getAllByTestId('hub-pool-model')).toHaveLength(1));
    expect(screen.getAllByTestId('hub-pool-model')[0]?.getAttribute('data-model')).toBe('qwen3:8b');
    // A filter is a view concern: it must not have written anything.
    expect(fixtures.updateSettings).not.toHaveBeenCalled();
  });
});
