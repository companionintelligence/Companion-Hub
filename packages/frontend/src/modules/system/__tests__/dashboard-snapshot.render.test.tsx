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
  memory: {} as Record<string, unknown>,
  cloud: [] as Record<string, unknown>[],
  inference: {} as Record<string, unknown>,
  monitor: {} as Record<string, unknown>,
  residency: {} as Record<string, unknown>,
}));

/*
 * No i18n mock. `src/tests/setup.ts` already initialises the real i18next against the real
 * `en.json`, so the snapshot renders the strings a user sees. The hand-mirrored subset that used
 * to live here drifted the moment a panel gained a key, and a snapshot full of raw
 * SCREAMING_KEYS hides exactly the rendering problem it exists to show.
 */

vi.mock('@/lib/app-runtime-monitor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAppRuntimeMonitor: async () => fixtures.monitor,
}));
vi.mock('@/lib/api-routes/named-status-routes', () => ({
  inferenceStatusOptions: () => ({ queryKey: ['inference-status'], queryFn: async () => fixtures.inference }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  poolStatusOptions: () => ({ queryKey: ['pool-status'], queryFn: async () => fixtures.pool }),
  getPoolRoutingLogOptions: () => ({ queryKey: ['pool-log'], queryFn: async () => fixtures.log }),
  getHardwareOptions: () => ({ queryKey: ['hardware'], queryFn: async () => fixtures.hardware }),
  getMemoryOptions: () => ({ queryKey: ['memory'], queryFn: async () => fixtures.memory }),
  getCloudProvidersOptions: () => ({ queryKey: ['cloud'], queryFn: async () => fixtures.cloud }),
  // `useDashboardData` imports this too. Leaving it out threw on every run, which nothing
  // noticed because the suite is env-gated and CI never sets the variable.
  getResidentModelsOptions: () => ({ queryKey: ['residency'], queryFn: async () => fixtures.residency }),
}));

/** Ages are relative to the render so "last seen" and the per-minute bars read as they would live. */
const NOW = Date.now();
const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
/** `lastSeenAt` arrives space-separated from the database, not as a T-ISO string. */
const seenAgo = (seconds: number) => secondsAgo(seconds).replace('T', ' ').replace('Z', '');

const peer = (
  name: string,
  tier: string,
  models: string[],
  inFlight: number | undefined,
  seenSecondsAgo: number,
  extras: Record<string, unknown> = {},
) => ({
  id: `peer-${name}`,
  nodeFqdn: `${name}.capybara-ulmer.ts.net`,
  displayName: name,
  direction: 'inbound',
  status: 'connected',
  enabled: true,
  consecutiveFailures: 0,
  lastSeenAt: seenAgo(seenSecondsAgo),
  inFlightRequests: inFlight,
  lastCapabilities: { hardwareTier: tier, backends: [{ type: 'ollama', healthy: true, modelsLoaded: models }] },
  ...extras,
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
      directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
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
          { type: 'omlx', healthy: true, modelsLoaded: ['mlx-community/Qwen3-8B-4bit'] },
          { type: 'lemonade', healthy: false, modelsLoaded: [] },
        ],
      },
      peerCounts: { total: 3, connected: 3, pending: 0, unreachable: 0, disabled: 0 },
      routing: { recorded: 14, capacity: 200, served: 13, failed: 1, failovers: 0, lastAt: '2026-09-10T02:31:00Z' },
    };
    fixtures.pool.peers = [
      // Reports containers and a measured band; also reports its own queue depth.
      peer('core-2', 'high', ['gemma3:27b', 'qwen2.5-coder:32b', 'ornith-1.5:9b'], 0, 12, {
        gpuPressure: 2,
        containers: { running: 9, stopped: 2, total: 11, cpuPercent: 61.4, memoryBytes: 7_400_000_000 },
        lastCapabilities: {
          hardwareTier: 'high',
          backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:27b', 'qwen2.5-coder:32b', 'ornith-1.5:9b'] }],
          inFlightRequests: 3,
        },
      }),
      // Reports nothing but models: no counter, no band, containers explicitly null. Every one of
      // those must render as a dash or "not reported", never as a zero.
      peer('beta-red', 'low', ['qwen2.5-coder:7b', 'qwen3:8b'], undefined, 41, { containers: null }),
      peer('core-7', 'high', ['gabegoodhart/minimax-m2:230b', 'qwen3-vl:32b', 'gemma4:31b'], 2, 8, {
        gpuPressure: 0,
        containers: { running: 4, stopped: 0, total: 4, cpuPercent: 8.2, memoryBytes: 1_200_000_000 },
      }),
    ];
    fixtures.log = {
      summary: { recorded: 14, served: 13, failed: 1, failovers: 1 },
      entries: [
        {
          at: secondsAgo(20),
          direction: 'outbound',
          model: 'ornith-1.5:9b',
          node: 'core-2.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 1732,
        },
        {
          at: secondsAgo(75),
          direction: 'inbound',
          model: null,
          node: 'core-7.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 842,
        },
        {
          at: secondsAgo(140),
          direction: 'outbound',
          model: 'qwen2.5-coder:7b',
          node: 'beta-red.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 20_124,
          failedOverFrom: ['core-2.capybara-ulmer.ts.net'],
        },
        {
          at: secondsAgo(190),
          direction: 'outbound',
          model: 'qwen3-vl:32b',
          node: 'local',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 311,
        },
        {
          at: secondsAgo(260),
          direction: 'outbound',
          model: 'zzz-nonexistent:999b',
          node: null,
          backend: null,
          outcome: 'failed',
          status: 502,
          durationMs: 96,
        },
        {
          at: secondsAgo(430),
          direction: 'outbound',
          model: 'gemma4:26b',
          node: 'core-7.capybara-ulmer.ts.net',
          backend: 'ollama',
          outcome: 'served',
          status: 200,
          durationMs: 2104,
          pin: { scope: 'model' },
        },
        {
          at: secondsAgo(720),
          direction: 'inbound',
          model: null,
          node: 'core-2.capybara-ulmer.ts.net',
          backend: 'vllm',
          outcome: 'served',
          status: 200,
          durationMs: 1290,
        },
      ],
    };
    fixtures.memory = {
      totalVramMb: 0,
      totalRamMb: 131_072,
      systemReservedRamMb: 8192,
      dockerOverheadMb: 5120,
      appContainerBudgetMb: 32_768,
      modelBudgetVramMb: 0,
      modelBudgetRamMb: 63_488,
      modelUsedVramMb: 0,
      modelUsedRamMb: 41_984,
      pinnedVramMb: 0,
      pinnedRamMb: 12_288,
    };
    fixtures.cloud = [];
    /*
     * Residency is read by the rail. Two of the four engines answer, and two are `unsupported` /
     * `unreachable` — which is not "nothing is resident on them", it is "they were not asked". The
     * rail names those two under the count rather than folding them into it.
     */
    fixtures.residency = {
      backends: [
        {
          backend: 'ollama',
          source: 'measured',
          models: [
            {
              id: 'qwen3-vl:32b',
              engineGpuBytes: 7_674_000_000,
              totalBytes: 7_674_000_000,
              expiresAt: null,
              contextLength: 8192,
              quantization: 'Q4_K_M',
            },
          ],
        },
        {
          backend: 'vllm',
          source: 'implicit',
          models: [{ id: 'Qwen/Qwen3.5-9B', engineGpuBytes: null, totalBytes: null, expiresAt: null, contextLength: null, quantization: null }],
        },
        { backend: 'lemonade', source: 'unreachable', models: null, error: 'connection refused' },
        { backend: 'omlx', source: 'unsupported', models: null },
      ],
      residentCount: 2,
      sampledAt: secondsAgo(5),
    };
    fixtures.inference = {
      backends: [
        { type: 'ollama', running: true, healthy: true, modelsLoaded: 7 },
        { type: 'vllm', running: true, healthy: true, modelsLoaded: 1 },
        { type: 'lemonade', running: false, healthy: false, modelsLoaded: 0 },
        { type: 'omlx', running: true, healthy: true, modelsLoaded: 1 },
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
          // None of this fixture's apps hold GPU memory in real life either — the fleet's GPU
          // consumers are ollama (a host process) and vllm/lucebox, none of which are marketplace
          // apps this monitor tracks as a workload.
          gpuVramMb: null,
        })),
      })),
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

/*
 * A REAL CHECK, not gated on `DASHBOARD_SNAPSHOT_OUT`.
 *
 * The snapshot above is a development affordance that CI never runs, which is how this page
 * shipped three absence-as-zero regressions with a green suite. The coverage tile is the one
 * element on the board whose correctness is entirely structural — it must state that GPU and
 * token metering do not exist, and it must be incapable of drawing anything that could be read
 * as a measurement of them — so it is asserted here where CI will actually run it.
 */
describe('workload coverage tile', () => {
  it('says what is not measured and draws nothing at all', async () => {
    fixtures.hardware = { gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 128_085, unifiedMemory: true } };
    fixtures.pool = {};
    fixtures.log = { entries: [] };
    fixtures.memory = {};
    fixtures.cloud = [];
    fixtures.inference = {};
    fixtures.residency = { backends: [], residentCount: 0, sampledAt: secondsAgo(5) };
    fixtures.monitor = { sampledAt: secondsAgo(5), apps: [], history: [] };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ResourceMonitorPage />
      </QueryClientProvider>,
    );

    const tile = container.querySelector('[data-testid="workload-coverage"]') as HTMLElement | null;
    expect(tile).not.toBeNull();

    // The words, in the register the copy rules fix: present tense, and never "0", "—",
    // "no data", "unavailable" or "coming soon".
    //
    // GPU VRAM is real now (see workload-trends.tsx) — this tile's GPU tag says so precisely
    // ("VRAM only") rather than the blanket "Not measured" it used to say; compute UTILIZATION
    // per workload is the half that remains genuinely unmeasured. Tokens are unchanged: still
    // "Not recorded" per workload, even though real per-model counts now exist elsewhere.
    expect(tile?.textContent).toContain('VRAM only');
    expect(tile?.textContent).toContain('NOT measured');
    expect(tile?.textContent).toContain('Not recorded');
    expect(tile?.textContent).toContain('GPU per workload');
    expect(tile?.textContent).toContain('LLM tokens per workload');
    // Not a substring check: the prose legitimately uses em-dashes as punctuation. What must not
    // exist is an element whose WHOLE content is a dash or a zero — that is a read-out, and a
    // read-out here would be a measurement of something that is not measured.
    const readouts = [...(tile?.querySelectorAll('*') ?? [])].map((node) => (node.textContent ?? '').trim());
    expect(readouts).not.toContain('—');
    expect(readouts).not.toContain('0');
    expect(readouts).not.toContain('0%');

    // The copy rules, enforced: never "no data" (reads as an empty result set), never
    // "unavailable" (reads as a failed fetch), never "coming soon" (a roadmap promise).
    for (const banned of ['No data', 'no data', 'Unavailable', 'unavailable', 'Coming soon', 'coming soon']) {
      expect(tile?.textContent).not.toContain(banned);
    }

    // No axis, no gridline, no baseline, no plot frame, no legend swatch — no SVG of any kind.
    // An empty chart frame beside a populated one reads as loading-or-broken, which is the
    // absence/idleness collision in a different costume.
    expect(tile?.querySelector('svg')).toBeNull();

    // Dashed means "waiting for samples" everywhere else on this page. GPU-per-workload is not
    // waiting; it was never built, so the tile uses a solid left accent rule instead.
    expect(tile?.className).not.toContain('border-dashed');

    // The host GPU is a fact about hardware, not a per-workload metric, and it is the only thing
    // the tile reads. It must arrive without ever gating the statement above it.
    await waitFor(() => expect(tile?.textContent).toContain('Radeon 8060S'), { timeout: 5000 });
  });
});
