import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { BackendHealthStatus } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { MtplxBackend } from '@/modules/inference/backends/mtplx.backend';
import { DsparkBackend } from '@/modules/inference/backends/dspark.backend';
import { LuceboxBackend } from '@/modules/inference/backends/lucebox.backend';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolLocalHealthService, PLACEMENT_PROBE_BUDGET_MS, PROBE_SNAPSHOT_MAX_STALE_MS } from '../hub-pool-local-health.service';

const DOWN: BackendHealthStatus = { running: false, healthy: false, modelsLoaded: [] };
const UP: BackendHealthStatus = { running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] };

describe('HubPoolLocalHealthService', () => {
  let ollama: MockProxy<OllamaBackend>;
  let vllm: MockProxy<VllmBackend>;
  let configuration: MockProxy<ConfigurationService>;
  let service: HubPoolLocalHealthService;

  function setPoolPreferences(overrides: Partial<HubPoolPreferences>): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolRequireSignedPeers: false,
      poolShareContainerStats: true,
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      poolMaxPromptTokens: null,
      poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      poolPins: [],
      poolRouteAppsAlways: true,
      ...overrides,
    });
  }

  /** `read()`'s answer for one backend, so assertions name the engine rather than an index. */
  async function healthOf(type: 'ollama' | 'vllm'): Promise<{ health: BackendHealthStatus; probedAt: number }> {
    const entry = (await service.read()).find((candidate) => candidate.type === type);
    if (!entry) throw new Error(`no ${type} in the snapshot`);
    return { health: entry.health, probedAt: entry.probedAt };
  }

  beforeEach(() => {
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    const others = [mock<LemonadeBackend>(), mock<MtplxBackend>(), mock<DsparkBackend>(), mock<LuceboxBackend>()];
    for (const backend of [ollama, vllm, ...others]) {
      backend.healthCheck.mockResolvedValue(DOWN);
    }
    const [lemonade, mtplx, dspark, lucebox] = others as [LemonadeBackend, MtplxBackend, DsparkBackend, LuceboxBackend];
    configuration = mock<ConfigurationService>();
    setPoolPreferences({});
    service = new HubPoolLocalHealthService(new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox), configuration);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers in registry order whatever order the probes settle in', async () => {
    // Ollama is the slow one here; the ranker's stable sort turns this order into the local
    // tie-break, so it must not become "whoever answered first".
    ollama.healthCheck.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(UP), 5)));

    expect((await service.read()).map((entry) => entry.type)).toEqual(['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox']);
  });

  it('shares one in-flight probe between concurrent cold reads', async () => {
    let release: (health: BackendHealthStatus) => void = () => {};
    ollama.healthCheck.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const reads = Promise.all([service.read(), service.read(), service.read()]);
    release(UP);
    await reads;

    expect(ollama.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('folds a probe that throws into a running:false answer carrying the message', async () => {
    ollama.healthCheck.mockRejectedValue(new Error('connect ECONNREFUSED'));

    expect((await healthOf('ollama')).health).toEqual({ running: false, healthy: false, modelsLoaded: [], error: 'connect ECONNREFUSED' });
  });

  it('records the answer a hung probe eventually gives, over the placeholder the budget wrote', async () => {
    vi.useFakeTimers();
    let release: (health: BackendHealthStatus) => void = () => {};
    vllm.healthCheck.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const first = healthOf('vllm');
    await vi.advanceTimersByTimeAsync(PLACEMENT_PROBE_BUDGET_MS);
    expect((await first).health).toMatchObject({
      running: false,
      error: expect.stringContaining(`${PLACEMENT_PROBE_BUDGET_MS} ms placement budget`),
    });

    // The engine answers 3 s later — a DROPped port would never get here, a slow one does — and
    // the next read sees the real answer rather than the placeholder until its TTL.
    await vi.advanceTimersByTimeAsync(3_000);
    release(UP);
    await vi.advanceTimersByTimeAsync(0);
    expect((await healthOf('vllm')).health).toEqual(UP);
    expect(vllm.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('serves a stale answer and refreshes behind the caller inside the max-stale window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ollama.healthCheck.mockResolvedValue(UP);
    const { probedAt } = await healthOf('ollama');
    ollama.healthCheck.mockResolvedValue(DOWN);

    vi.setSystemTime(Date.now() + DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS + 1);
    const stale = await healthOf('ollama');
    expect(stale).toEqual({ health: UP, probedAt });

    expect((await healthOf('ollama')).health).toEqual(DOWN);
  });

  it('waits for a fresh answer once a snapshot is older than the max-stale window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ollama.healthCheck.mockResolvedValue(UP);
    await healthOf('ollama');
    ollama.healthCheck.mockResolvedValue(DOWN);

    vi.setSystemTime(Date.now() + DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS + PROBE_SNAPSHOT_MAX_STALE_MS + 1);

    // Blocking, not stale-served: an answer this old is not evidence of anything any more.
    expect((await healthOf('ollama')).health).toEqual(DOWN);
  });

  it('forgets an invalidated backend so the next read probes it again', async () => {
    ollama.healthCheck.mockResolvedValue(UP);
    await healthOf('ollama');
    ollama.healthCheck.mockResolvedValue({ ...UP, unservableModels: ['llama3.2:3b'] });

    service.invalidate('ollama');

    expect((await healthOf('ollama')).health.unservableModels).toEqual(['llama3.2:3b']);
    // Only the invalidated backend was re-asked; the rest are still inside their TTL.
    expect(vllm.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('honours a TTL PATCHed between reads', async () => {
    ollama.healthCheck.mockResolvedValue(UP);
    await healthOf('ollama');
    setPoolPreferences({ poolProbeSnapshotTtlMs: 0 });
    ollama.healthCheck.mockResolvedValue(DOWN);

    expect((await healthOf('ollama')).health).toEqual(DOWN);
  });
});
