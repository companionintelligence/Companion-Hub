import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { HubPoolSection } from '../hub-pool-settings';

/*
 * Renders the real Hub Pool section against a realistic snapshot of beta-max and writes
 * the markup to disk, so the redesign can be LOOKED AT with the app's own stylesheet
 * rather than only asserted on. Skipped unless HUB_POOL_SNAPSHOT_OUT names a file — it
 * is a development affordance, not a check, and it must not run in CI.
 */
const OUT = process.env.HUB_POOL_SNAPSHOT_OUT;

const fixtures = vi.hoisted(() => ({ status: {} as Record<string, unknown> }));

vi.mock('react-i18next', () => {
  // Real English, not key echoes: the point is to see the page as an operator would.
  const strings: Record<string, string> = {
    HUB_POOL_SECTION_TITLE: 'Hub Pool',
    HUB_POOL_STATE_ROUTING: 'Routing',
    HUB_POOL_FIELD_PEERS: 'Peers',
    HUB_POOL_FIELD_QUEUE: 'In flight',
    HUB_POOL_FIELD_HARDWARE: 'Tier',
    HUB_POOL_FIELD_NODE: 'This node',
    HUB_POOL_FIELD_TAILNET: 'Tailnet',
    HUB_POOL_FIELD_LOCAL_BACKENDS: 'Local engines',
    HUB_POOL_ROUTING_SERVED: 'Served',
    HUB_POOL_ROUTING_FAILED: 'Failed',
    HUB_POOL_CONTROLS_TITLE: 'Controls',
    HUB_POOL_TOGGLE_LABEL: 'Pool inference with paired Hubs',
    HUB_POOL_OUTBOUND_LABEL: 'Send work to paired Hubs',
    HUB_POOL_INBOUND_LABEL: 'Serve work for paired Hubs',
    HUB_POOL_AFFINITY_LABEL: 'Local affinity (queued requests)',
    HUB_POOL_POLL_LABEL: 'Peer health check (seconds)',
    HUB_POOL_PAIRED_TITLE: 'Paired Hubs',
    HUB_POOL_PINS_TITLE: 'Routing pins',
    HUB_POOL_PINS_EMPTY: 'No pins.',
    HUB_POOL_PINS_ALL_MODELS: 'Every model',
    HUB_POOL_LOCAL_NODE_LABEL: 'This Hub',
    HUB_POOL_STATUS_CONNECTED: 'Connected',
    HUB_POOL_PEER_IN_POOL: 'In the pool',
    HUB_POOL_UNPAIR: 'Unpair',
    HUB_POOL_BACKEND_SUMMARY: '{{backend}} ({{models}} models)',
    COMMON_SAVE: 'Save',
    COMMON_UNKNOWN: 'unknown',
  };
  const t = (key: string, vars?: Record<string, unknown>) => {
    const raw = strings[key] ?? key;

    return vars ? raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? '')) : raw;
  };

  return { useTranslation: () => ({ t }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
vi.mock('@/api-client/client.gen', () => ({ client: { post: vi.fn(), delete: vi.fn(), patch: vi.fn() } }));
vi.mock('@/api-client/sdk.gen', () => ({
  pairPeer: vi.fn(),
  approvePeer: vi.fn(),
  rejectPeer: vi.fn(),
  removePeer: vi.fn(),
  upsertPoolPin: vi.fn(),
  deletePoolPin: vi.fn(),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusQueryKey: () => ['pool-status'],
  poolStatusOptions: () => ({ queryKey: ['pool-status'], queryFn: async () => fixtures.status }),
  listDiscoverableQueryKey: () => ['pool-discoverable'],
  listDiscoverableOptions: () => ({ queryKey: ['pool-discoverable'], queryFn: async () => [] }),
  getPoolRoutingLogQueryKey: () => ['pool-routing-log'],
  getPoolRoutingLogOptions: () => ({
    queryKey: ['pool-routing-log'],
    queryFn: async () => ({ entries: [], summary: { recorded: 0, capacity: 200, served: 0, failed: 0, failovers: 0, lastAt: null } }),
  }),
  updatePoolSettings: vi.fn(),
  updatePoolSettingsMutation: () => ({ mutationFn: vi.fn() }),
}));

const peer = (name: string, models: string[]) => ({
  id: `peer-${name}`,
  nodeFqdn: `${name}.capybara-ulmer.ts.net`,
  displayName: name,
  direction: 'inbound',
  status: 'connected',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: '2026-09-10 02:25:53.896',
  bearerOnly: false,
  lastCapabilities: { backends: [{ type: 'ollama', healthy: true, modelsLoaded: models }] },
});

describe.skipIf(!OUT)('Hub Pool visual snapshot', () => {
  it('writes the redesigned section to disk', async () => {
    fixtures.status = {
      enabled: true,
      disabledBy: null,
      directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
      reason: 'active',
      routingActive: true,
      settings: {
        poolEnabled: true,
        poolOutboundEnabled: true,
        poolInboundEnabled: true,
        poolLocalAffinity: 1,
        poolHealthPollSeconds: 30,
        poolRequireSignedPeers: false,
        poolPressureWeight: 0,
        poolPins: [],
      },
      pins: [],
      tailscaleAdminApiConfigured: false,
      localNode: {
        nodeFqdn: 'beta-max.capybara-ulmer.ts.net',
        tailnet: 'capybara-ulmer.ts.net',
        hardwareTier: 'high',
        inFlightRequests: 0,
        tailscaleConnected: true,
        capabilitiesError: null,
        backends: [
          { type: 'ollama', healthy: true, modelsLoaded: Array.from({ length: 11 }, (_, i) => `m${i}`) },
          { type: 'vllm', healthy: true, modelsLoaded: ['Qwen/Qwen3.5-9B'] },
          { type: 'omlx', healthy: true, modelsLoaded: ['mlx-community/Qwen3-8B-4bit'] },
        ],
      },
      peers: [peer('core-2', ['gemma3:27b']), peer('beta-red', ['qwen2.5-coder:7b']), peer('core-7', ['ornith-1.5:9b'])],
      peerCounts: { total: 3, connected: 3, pending: 0, unreachable: 0, disabled: 0 },
      routing: { recorded: 12, capacity: 200, served: 12, failed: 0, failovers: 0, lastAt: '2026-09-10T02:25:00Z' },
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <HubPoolSection />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(container.querySelector('[data-testid="hub-pool-card"]')).toBeTruthy());
    writeFileSync(OUT as string, container.innerHTML, 'utf-8');
  });
});
