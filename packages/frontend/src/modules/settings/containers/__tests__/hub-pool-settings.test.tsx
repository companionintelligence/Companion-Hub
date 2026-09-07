import { removePeer } from '@/api-client/sdk.gen';
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
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
// The per-peer verbs and the two directional switches go through the generated client's low-level
// post/patch until swagger.json and the api-client are regenerated; see hub-pool-settings.tsx.
vi.mock('@/api-client/client.gen', () => ({
  client: { post: fixtures.peerToggle, patch: fixtures.patchSettings },
}));
vi.mock('@/api-client/sdk.gen', () => ({
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
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
      settings: { poolEnabled: true, poolOutboundEnabled: true, poolInboundEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
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
    expect(screen.getAllByTestId('hub-pool-model').map((row) => row.textContent)).toEqual(['llama3.2:3bHUB_POOL_LOCAL_NODE_LABEL']);
  });

  it('merges the model inventory across the pool and names every node holding each model', async () => {
    fixtures.status = baseStatus({
      peers: [connectedPeer()],
      peerCounts: { total: 1, connected: 1, pending: 0, unreachable: 0 },
    });

    renderSection();

    const rows = await screen.findAllByTestId('hub-pool-model');
    expect(rows.map((row) => row.textContent)).toEqual(['llama3.2:3bHUB_POOL_LOCAL_NODE_LABELStudio Hub', 'qwen3:8bStudio Hub']);
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
    expect(failovers[0]?.textContent).toBe('HUB_POOL_ROUTING_FAILOVER');
    expect(screen.getByText('HUB_POOL_ROUTING_INBOUND')).toBeTruthy();
  });

  it('says the discovery credential is missing instead of showing an empty device list', async () => {
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
});
