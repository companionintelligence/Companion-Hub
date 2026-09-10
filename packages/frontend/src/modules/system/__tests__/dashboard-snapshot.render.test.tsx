import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import ResourceMonitorPage from '../pages/resource-monitor-page';

/*
 * Renders the resource dashboard against a snapshot of the real beta-max pool node and
 * writes the markup to disk, so the layout can be looked at with the app's own
 * stylesheet rather than only asserted on. Skipped unless DASHBOARD_SNAPSHOT_OUT names
 * a file — a development affordance, not a check, and it must not run in CI.
 */
const OUT = process.env.DASHBOARD_SNAPSHOT_OUT;

const fixtures = vi.hoisted(() => ({
  pool: {} as Record<string, unknown>,
  peers: [] as Record<string, unknown>[],
  log: {} as Record<string, unknown>,
  hardware: {} as Record<string, unknown>,
  inference: {} as Record<string, unknown>,
  monitor: {} as Record<string, unknown>,
  residency: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => {
  const strings: Record<string, string> = {
    RESOURCE_MONITOR_TITLE: 'Resources',
    RESOURCE_MONITOR_CHART_TITLE: 'Workload CPU over time',
    RESOURCE_MONITOR_CHART_WAITING: 'Collecting samples…',
    RESOURCE_MONITOR_LAST_SAMPLED: 'sampled {{time}}',
    DASHBOARD_SECTION_LOCAL: 'Local resources',
    DASHBOARD_SECTION_NETWORK: 'Network resources',
    DASHBOARD_SECTION_POOLING: 'AI pooling and misc',
    DASHBOARD_THIS_HUB: 'This Hub',
    DASHBOARD_POOLED: 'Pooled',
    DASHBOARD_HOST_TITLE: 'Host capacity',
    DASHBOARD_CORES: 'Cores',
    DASHBOARD_RAM: 'RAM',
    DASHBOARD_VRAM: 'VRAM',
    DASHBOARD_TIER: 'Tier',
    DASHBOARD_IN_FLIGHT: 'In flight',
    DASHBOARD_RAM_USED: '{{used}} of {{total}} in use',
    DASHBOARD_INFERENCE_BUDGET: '{{mb}} for inference',
    DASHBOARD_LOCAL_MODELS_TITLE: 'AI models held on this node',
    DASHBOARD_RESIDENT_TITLE: 'AI models resident in memory',
    DASHBOARD_RESIDENT_VRAM: '{{size}} VRAM',
    DASHBOARD_NOTHING_RESIDENT: 'Nothing loaded — models load on first request.',
    DASHBOARD_COL_VRAM: 'VRAM',
    DASHBOARD_COL_EXPIRES: 'Expires',
    DASHBOARD_RESIDENCY_UNKNOWN: 'Residency unknown for: {{engines}}',
    DASHBOARD_LOCAL_CONTAINERS_TITLE: 'Containers on this node',
    DASHBOARD_CONTAINER_COUNT: '{{count}} containers',
    DASHBOARD_COL_MODEL: 'Model',
    DASHBOARD_COL_ENGINE: 'Engine',
    DASHBOARD_COL_STATE: 'State',
    DASHBOARD_COL_WORKLOAD: 'Workload',
    DASHBOARD_COL_CPU: 'CPU',
    DASHBOARD_COL_TREND: 'Trend',
    DASHBOARD_COL_MEMORY: 'Memory',
    DASHBOARD_COL_CONTAINERS: 'Ctr',
    DASHBOARD_COL_NODES: 'Nodes',
    DASHBOARD_COL_AVAILABLE_ON: 'Available on',
    DASHBOARD_COL_NODE: 'Node',
    DASHBOARD_COL_DIRECTION: 'Dir',
    DASHBOARD_COL_TIER: 'Tier',
    DASHBOARD_COL_MODELS: 'Models',
    DASHBOARD_COL_IN_FLIGHT: 'In flight',
    DASHBOARD_COL_FAILURES: 'Fails',
    DASHBOARD_COL_LAST_SEEN: 'Last seen',
    DASHBOARD_COL_AGE: 'Age',
    DASHBOARD_COL_LATENCY: 'Latency',
    DASHBOARD_COL_OUTCOME: 'Result',
    DASHBOARD_COL_FIELD: 'Field',
    DASHBOARD_COL_VALUE: 'Value',
    DASHBOARD_NETWORK_OVERVIEW_TITLE: 'Pool reach',
    DASHBOARD_NETWORK_MODELS_TITLE: 'AI models across the pool',
    DASHBOARD_NETWORK_NODES_TITLE: 'Peer nodes',
    DASHBOARD_NETWORK_CONTAINERS_TITLE: 'Containers across the pool',
    DASHBOARD_NETWORK_CONTAINERS_UNAVAILABLE:
      'Hubs share inference capacity, not container inventory — open a peer’s own dashboard to see its workloads.',
    DASHBOARD_PEERS_CONNECTED: 'Peers',
    DASHBOARD_REACHABLE_MODELS: 'Reachable',
    DASHBOARD_EXCLUSIVE_MODELS: 'Peer only',
    DASHBOARD_PEER_IN_FLIGHT: 'Peer load',
    DASHBOARD_POOL_SUMMARY_TITLE: 'Pool routing',
    DASHBOARD_POOL_ON: 'On',
    DASHBOARD_POOL_ROUTING: 'Routing',
    DASHBOARD_SERVED: 'Served',
    DASHBOARD_FAILED: 'Failed',
    DASHBOARD_FAILOVERS: 'Failovers',
    DASHBOARD_AFFINITY: 'Affinity',
    DASHBOARD_HEALTH_POLL: 'Poll',
    DASHBOARD_ROUTING_LOG_TITLE: 'Recent routing',
    DASHBOARD_MISC_TITLE: 'Node details',
    DASHBOARD_MISC_NODE: 'Node',
    DASHBOARD_MISC_TAILNET: 'Tailnet',
    DASHBOARD_MISC_TAILSCALE: 'Tailscale',
    DASHBOARD_MISC_OS: 'OS',
    DASHBOARD_MISC_CPU: 'CPU',
    DASHBOARD_MISC_GPU: 'GPU',
    DASHBOARD_MISC_GPU_RUNTIME: 'GPU runtime',
    DASHBOARD_CONNECTED: 'Connected',
    DASHBOARD_AVAILABLE: 'Available',
    DASHBOARD_UNAVAILABLE: 'Unavailable',
  };
  const t = (key: string, vars?: Record<string, unknown>) => {
    const raw = strings[key] ?? key;

    return vars ? raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? '')) : raw;
  };

  return { useTranslation: () => ({ t }) };
});

vi.mock('@/lib/app-runtime-monitor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAppRuntimeMonitor: async () => fixtures.monitor,
}));
vi.mock('@/lib/api-routes/named-status-routes', () => ({
  inferenceStatusOptions: () => ({ queryKey: ['inference-status'], queryFn: async () => fixtures.inference }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusOptions: () => ({ queryKey: ['pool-status'], queryFn: async () => fixtures.pool }),
  listPeersOptions: () => ({ queryKey: ['pool-peers'], queryFn: async () => fixtures.peers }),
  getPoolRoutingLogOptions: () => ({ queryKey: ['pool-log'], queryFn: async () => fixtures.log }),
  getHardwareOptions: () => ({ queryKey: ['hardware'], queryFn: async () => fixtures.hardware }),
  getResidentModelsOptions: () => ({ queryKey: ['residency'], queryFn: async () => fixtures.residency }),
}));

const peer = (name: string, tier: string, models: string[], inFlight: number | undefined, seen: string) => ({
  id: `peer-${name}`,
  nodeFqdn: `${name}.capybara-ulmer.ts.net`,
  displayName: name,
  direction: 'inbound',
  status: 'connected',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: seen,
  inFlightRequests: inFlight,
  lastCapabilities: { hardwareTier: tier, backends: [{ type: 'ollama', healthy: true, modelsLoaded: models }] },
});

describe.skipIf(!OUT)('resource dashboard snapshot', () => {
  it('writes the dashboard to disk', async () => {
    fixtures.hardware = {
      gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 128085, unifiedMemory: true, runtimeAvailable: false },
      ram: { totalMb: 128085, availableMb: 62000 },
      cpu: { arch: 'x86_64', cores: 32, model: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S' },
      os: { platform: 'linux', name: 'Alpine Linux', version: 'v3.21' },
      tier: 'high',
      effectiveInferenceMemoryMb: 62000,
    };
    fixtures.pool = {
      enabled: true,
      routingActive: true,
      reason: 'active',
      settings: { poolEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
      localNode: {
        nodeFqdn: 'beta-max.capybara-ulmer.ts.net',
        tailnet: 'capybara-ulmer.ts.net',
        hardwareTier: 'high',
        inFlightRequests: 0,
        tailscaleConnected: true,
        capabilitiesError: null,
        backends: [
          {
            type: 'ollama',
            healthy: true,
            modelsLoaded: ['gemma3:1b', 'gemma4:26b', 'gemma4:e4b', 'nomic-embed-text:latest', 'ornith-1.5:35b', 'qwen3-coder:30b', 'qwen3-vl:32b'],
          },
          { type: 'vllm', healthy: true, modelsLoaded: ['Qwen/Qwen3.5-9B'] },
          { type: 'lucebox', healthy: true, modelsLoaded: ['lucebox-default'] },
          { type: 'lemonade', healthy: false, modelsLoaded: [] },
        ],
      },
      peerCounts: { total: 3, connected: 3, pending: 0, unreachable: 0, disabled: 0 },
      routing: { recorded: 14, capacity: 200, served: 13, failed: 1, failovers: 0, lastAt: '2026-09-10T02:31:00Z' },
    };
    fixtures.peers = [
      peer('core-2', 'high', ['gemma3:27b', 'qwen2.5-coder:32b', 'ornith-1.5:9b'], 0, '2026-09-10 02:31:10.495'),
      peer('beta-red', 'low', ['qwen2.5-coder:7b', 'qwen3:8b'], undefined, '2026-09-10 02:30:55.100'),
      peer('core-7', 'high', ['gabegoodhart/minimax-m2:230b', 'qwen3-vl:32b', 'gemma4:31b'], 2, '2026-09-10 02:31:12.000'),
    ];
    fixtures.log = {
      summary: { recorded: 14, served: 13, failed: 1, failovers: 0 },
      entries: [
        {
          at: '2026-09-10T02:31:10.495Z',
          direction: 'outbound',
          model: 'ornith-1.5:9b',
          node: 'core-2.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 1732,
        },
        {
          at: '2026-09-10T02:30:40.100Z',
          direction: 'inbound',
          model: 'qwen3-coder:30b',
          node: 'core-7.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 8420,
        },
        {
          at: '2026-09-10T02:29:55.000Z',
          direction: 'outbound',
          model: 'qwen2.5-coder:7b',
          node: 'beta-red.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 20124,
        },
        {
          at: '2026-09-10T02:28:11.000Z',
          direction: 'outbound',
          model: 'zzz-nonexistent:999b',
          node: null,
          backend: null,
          outcome: 'failed',
          status: 502,
          durationMs: null,
        },
      ],
    };
    fixtures.inference = {
      backends: [
        { type: 'ollama', running: true, healthy: true, modelsLoaded: 7 },
        { type: 'vllm', running: true, healthy: true, modelsLoaded: 1 },
        { type: 'lemonade', running: false, healthy: false, modelsLoaded: 0 },
        { type: 'lucebox', running: true, healthy: true, modelsLoaded: 1 },
      ],
    };
    const mkApp = (name: string, cpu: number, mem: number, containers: number, degraded = false) => ({
      appUrn: `urn:${name}`,
      appName: name,
      status: 'running',
      cpuPercent: cpu,
      memoryUsageBytes: mem,
      memoryLimitBytes: mem * 4,
      highCpu: cpu > 80,
      sustainedHighCpu: false,
      responsive: !degraded,
      degraded,
      forceStopEligible: false,
      reason: null,
      cpuLimit: null,
      usesDefaultCpuLimit: true,
      sampledAt: '2026-09-10T02:31:00Z',
      containers: Array.from({ length: containers }, (_, i) => ({
        containerId: `c${i}`,
        name: `${name}-${i}`,
        state: 'running',
        status: 'Up',
        health: null,
        cpuPercent: cpu / containers,
        memoryUsageBytes: mem / containers,
        memoryLimitBytes: mem,
      })),
    });
    const apps = [
      mkApp('Companion Memory', 42.3, 3_100_000_000, 6),
      mkApp('OpenClaw WebCLI', 12.7, 820_000_000, 1),
      mkApp('Import Tools', 3.1, 240_000_000, 1),
      mkApp('Hermes Gateway', 0.4, 96_000_000, 2, true),
    ];
    fixtures.monitor = {
      sampledAt: '2026-09-10T02:31:00Z',
      apps,
      history: Array.from({ length: 12 }, (_, i) => ({
        sampledAt: `2026-09-10T02:${String(19 + i).padStart(2, '0')}:00Z`,
        apps: apps.map((app) => ({
          appUrn: app.appUrn,
          appName: app.appName,
          status: 'running',
          cpuPercent: Math.max(0, app.cpuPercent + Math.sin(i / 2) * (app.cpuPercent / 3)),
          memoryUsageBytes: app.memoryUsageBytes,
          containerCount: app.containers.length,
        })),
      })),
    };

    // Verbatim from beta-max's ollama 0.33.3 /api/ps after loading gemma3:1b, plus a second
    // row constructed to show CPU offload (size > size_vram), which the live node did not
    // happen to exhibit.
    fixtures.residency = {
      sampledAt: '2026-09-10T03:31:00Z',
      residentCount: 2,
      totalVramBytes: 1_007_188_705 + 12_000_000_000,
      backends: [
        {
          backend: 'ollama',
          source: 'measured',
          models: [
            {
              id: 'gemma3:1b',
              vramBytes: 1_007_188_705,
              totalBytes: 1_007_188_705,
              expiresAt: '2026-09-10T03:36:45.391Z',
              contextLength: 32_768,
              quantization: 'Q4_K_M',
            },
            {
              id: 'qwen3-coder:30b',
              vramBytes: 12_000_000_000,
              totalBytes: 18_600_000_000,
              expiresAt: '2026-09-10T03:34:00.000Z',
              contextLength: 8_192,
              quantization: 'Q4_K_M',
            },
          ],
        },
        { backend: 'vllm', source: 'unsupported', models: null },
        { backend: 'lucebox', source: 'unsupported', models: null },
      ],
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ResourceMonitorPage />
      </QueryClientProvider>,
    );

    // Wait for real DATA, not a static heading — a title renders before any query settles.
    await waitFor(() => expect(container.textContent).toContain('beta-max.capybara-ulmer.ts.net'), { timeout: 5000 });
    await waitFor(() => expect(container.textContent).toContain('core-2'), { timeout: 5000 });
    await waitFor(() => expect(container.textContent).toContain('Companion Memory'), { timeout: 5000 });
    writeFileSync(OUT as string, container.innerHTML, 'utf-8');
  });
});
