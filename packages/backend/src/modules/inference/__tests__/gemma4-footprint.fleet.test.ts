import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { BackendResidency, CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { HubPoolLoadService } from '@/modules/hub-pool/hub-pool-load.service';
import { CURATED_MODELS } from '../catalog/curated-models';
import { handoutContextLength, visionReserveMbFor } from '../app-model-handout';
import { estimateLoadedFootprintMb } from '../context-length.util';
import { probeContextCost } from '../context-cost.util';
import { estimateContextCost, parseModelGeometry } from '../model-geometry.util';
import { InferenceRouterService } from '../inference-router.service';
import { MemoryManagerService, modelMemoryCeilingMb } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelResidencyService } from '../model-residency.service';
import { ModelPullerService } from '../model-puller.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { InferenceBackend } from '../backends/backend.interface';
import type { CloudFallbackService } from '../cloud-fallback.service';
import type { HardwareInspectorService } from '../hardware-inspector.service';
import type { GpuProcessSamplerService } from '../gpu-process-sampler.service';

/**
 * gemma4:e4b is the fleet's default app model, and until its catalog row carried a measured footprint
 * the Hub refused to pin or load it on the 8 and 10 GB cards it was already running on: the footprint
 * derived from its 9.6 GB download was 10,813 MB, and the context sizing then raised any smaller figure
 * back to the file size. These cases run the real catalog row through the real estimate, with the
 * engine's cost built from what beta-red's Ollama reports for the model.
 */

/** beta-red's `/api/show` `model_info` for gemma4:e4b, read 2026-09-30 (the fields the geometry reads). */
const GEMMA4_E4B_MODEL_INFO = {
  'general.architecture': 'gemma4',
  'gemma4.block_count': 42,
  'gemma4.attention.head_count': 8,
  'gemma4.attention.head_count_kv': 2,
  'gemma4.attention.key_length': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.shared_kv_layers': 18,
  'gemma4.attention.sliding_window': 512,
  'gemma4.embedding_length': 2560,
  'gemma4.context_length': 131_072,
};
/** beta-red's `/api/tags` size for gemma4:e4b. */
const GEMMA4_E4B_FILE_BYTES = 9_608_350_718;
const GEMMA4_E4B_COST = estimateContextCost({ geometry: parseModelGeometry(GEMMA4_E4B_MODEL_INFO), weightBytes: GEMMA4_E4B_FILE_BYTES });

const gemma4E4b = (): CuratedModel => {
  const row = CURATED_MODELS.find((m) => m.id === 'gemma4-e4b');
  if (!row) throw new Error('gemma4-e4b is missing from the catalog');
  return row;
};

const ollamaReporting = (cost: typeof GEMMA4_E4B_COST) =>
  ({ contextCostForModel: async (id: string) => (id === 'gemma4:e4b' ? cost : null) }) as unknown as InferenceBackend;

describe('gemma4:e4b on the cards the fleet runs it on', () => {
  it("reads beta-red's engine the way the Hub does: 0.09375 MB per token, a 9,163 MiB file", () => {
    expect(GEMMA4_E4B_COST?.kvMbPerToken).toBe(0.09375);
    expect(Math.round(GEMMA4_E4B_COST?.weightMb ?? 0)).toBe(9_163);
  });

  it('is sized from its measured footprint, not raised back to the 9,163 MiB file', async () => {
    const cost = await probeContextCost(ollamaReporting(GEMMA4_E4B_COST), gemma4E4b());

    // Matched, not equal: the cost carries more than these (the architecture, since #1686), and what
    // this pins is that the file size is gone while the engine's per-token cost stays.
    expect(cost).toMatchObject({ kvMbPerToken: 0.09375, weightMb: null, source: 'geometry' });
  });

  it('did not fit any of them at even the smallest window with the footprint derived from its download', () => {
    const derived = estimateLoadedFootprintMb({
      modelFootprintMb: 10_813,
      numCtx: 4_096,
      kvMbPerToken: GEMMA4_E4B_COST?.kvMbPerToken ?? null,
      weightMb: GEMMA4_E4B_COST?.weightMb ?? null,
      visionReserveMb: visionReserveMbFor(gemma4E4b()),
    });

    // The audit's "needs 13245 MB but only 9728 MB is free" on beta-red.
    expect(derived).toBe(13_245);
    expect(derived).toBeGreaterThan(modelMemoryCeilingMb(discrete('nvidia', 12_288)));
  });

  // What the apps are handed as CI_LLM_NUM_CTX: the derived footprint left no room for context after
  // the weights, so the handout fell to the 4096 floor on every card below 24 GB. Sized, as the env
  // resolver and the credentials handout size it, against what the card gives a model.
  it.each([
    ['an 8 GB card (beta-3-glass)', 8_192, 8_192],
    ['a 10 GB card (beta-red)', 10_240, 32_768],
  ])("hands %s's apps a larger window than the 4096 floor", async (_card, vramMb, window) => {
    const model = gemma4E4b();
    const cost = await probeContextCost(ollamaReporting(GEMMA4_E4B_COST), model);

    const handout = handoutContextLength({
      model,
      servedLocally: true,
      effectiveInferenceMemoryMb: modelMemoryCeilingMb(discrete('nvidia', vramMb)),
      kvMbPerToken: cost?.kvMbPerToken ?? null,
      weightMb: cost?.weightMb ?? null,
    });

    expect(handout).toBe(window);
  });
});

/** The card as the hardware inspector reports a discrete GPU. */
const discrete = (vendor: 'amd' | 'nvidia', vramMb: number): HardwareProfile => ({
  gpu: { available: true, vendor, model: 'dGPU', vramMb, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 31_017, availableMb: 27_621 },
  cpu: { arch: 'x86_64', cores: 12, model: 'x' },
  effectiveInferenceMemoryMb: vramMb,
  tier: 'medium',
});

const silent = (type: InferenceBackendType) => ({
  type,
  getBaseUrl: () => '',
  healthCheck: async () => ({ running: false, healthy: false, modelsLoaded: [] }),
  ...(type === 'lemonade' ? { listResident: async (): Promise<BackendResidency> => ({ backend: 'lemonade', source: 'measured', models: [] }) } : {}),
});

/**
 * A fresh card: gemma4:e4b downloaded, nothing resident, and a Hub that has never seen the model
 * loaded — the case the catalog figure alone decides. The engine reports the model's geometry and
 * file the way beta-red's Ollama does, and holds 5,550 MB once loaded (nvidia-smi on beta-red).
 */
function freshCard(vramMb: number) {
  const logger = mock<LoggerService>();
  const resident = new Map<string, number>();
  const loads: Array<{ id: string; contextLength?: number }> = [];
  const ollama = {
    type: 'ollama',
    getBaseUrl: () => 'http://fake-ollama:11434',
    healthCheck: async () => ({ running: true, healthy: true, modelsLoaded: ['gemma4:e4b'] }),
    isModelLoaded: async (id: string) => resident.has(id),
    contextCostForModel: async (id: string) => (id === 'gemma4:e4b' ? GEMMA4_E4B_COST : null),
    loadModel: async (id: string, options?: { contextLength?: number }) => {
      loads.push({ id, contextLength: options?.contextLength });
      resident.set(id, 5_550);
    },
    unloadModel: async (id: string) => {
      resident.delete(id);
    },
    listResident: async (): Promise<BackendResidency> => ({
      backend: 'ollama',
      source: 'measured',
      models: [...resident.keys()].map((id) => ({
        id,
        engineGpuBytes: 3_364_754_553,
        totalBytes: 3_364_754_553,
        expiresAt: null,
        contextLength: 16_384,
        quantization: null,
      })),
    }),
  };
  const backends = new InferenceBackendRegistry(ollama as never, silent('vllm') as never, silent('lemonade') as never, silent('omlx') as never);
  const registry = new ModelRegistryService(logger);
  const residency = new ModelResidencyService(backends, logger);
  const sampler = {
    sampleVramByProcess: async () =>
      [...resident.values()].map((vramMb) => ({ pid: 3697148, processName: '/usr/local/lib/ollama/llama-server', vramMb })),
  } as unknown as GpuProcessSamplerService;
  const memory = new MemoryManagerService(logger, registry, backends, residency, sampler);
  const hardware = { getProfile: async () => discrete('nvidia', vramMb) } as unknown as HardwareInspectorService;
  const puller = new ModelPullerService(logger, registry, hardware, memory, mock<HostMetricsService>(), backends);
  const router = new InferenceRouterService(
    logger,
    hardware,
    registry,
    memory,
    mock<CloudFallbackService>(),
    backends,
    puller,
    undefined,
    new HubPoolLoadService(),
  );
  registry.trackModel('gemma4-e4b', 'pulled');
  return { router, registry, memory, loads, logger };
}

describe('a fresh 8, 10 or 12 GB card loads and pins gemma4-e4b', () => {
  // The real load path, which sizes the window against what the card gives a model (the card less the
  // 512 MB kept for the display) and steps down to the largest window its estimate fits. beta-3-glass
  // (RTX 3070) gets 8192: 16384 is 7,946 MB against 7,680. beta-red (RTX 3080) and a 12 GB card get
  // 32768: 9,482 MB against 9,728, and 65536 would be 12,554.
  it.each([
    ['an 8 GB card (beta-3-glass)', 8_192, 8_192],
    ['a 10 GB card (beta-red)', 10_240, 32_768],
    ['a 12 GB card', 12_288, 32_768],
  ])("loads on %s (%d MB) at the window the load path's fit check sizes, %d tokens", async (_card, vramMb, window) => {
    const { router, registry, loads, logger } = freshCard(vramMb);

    await expect(router.loadTrackedModel('gemma4-e4b', { origin: 'operator' })).resolves.toEqual({ loaded: true });

    expect(loads).toEqual([{ id: 'gemma4:e4b', contextLength: window }]);
    expect(registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');
    // Fitted by the catalog, not tried because nothing else would admit it.
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('has never been measured'));
  });

  // An agent's MCP key may not try a load the catalog says will not fit (it could unload what apps
  // loaded), so on the derived 10,813 MB it was refused outright on every card below 24 GB.
  it("loads for an agent's MCP key too, since the catalog alone now fits it", async () => {
    const { router, loads } = freshCard(8_192);

    await expect(router.loadTrackedModel('gemma4-e4b', { origin: 'agent' })).resolves.toEqual({ loaded: true });
    expect(loads).toEqual([{ id: 'gemma4:e4b', contextLength: 8_192 }]);
  });

  // The boundary: with the reserves the estimate adds (KV at 0.09375 MB a token, the 1,024 MB margin
  // and the 1,024 MB vision reserve), a 6 GB card is still over at 4096 — 6,794 MB against 5,632 —
  // so an agent's load is refused there on the catalog.
  it('is still refused for an agent on a 6 GB card, which the estimate puts it over at 4096', async () => {
    const { router, loads } = freshCard(6_144);

    await expect(router.loadTrackedModel('gemma4-e4b', { origin: 'agent' })).resolves.toMatchObject({
      loaded: false,
      reason: expect.stringContaining('gemma4-e4b needs 6794 MB but only 5632 MB is free'),
    });
    expect(loads).toEqual([]);
  });

  it('lets it be pinned: its footprint is within what the card gives models', async () => {
    const { memory } = freshCard(10_240);

    await expect(memory.canPinModel(discrete('nvidia', 10_240), gemma4E4b().runtime.memoryFootprintMb)).resolves.toEqual({ canPin: true });
    await expect(memory.canPinModel(discrete('nvidia', 8_192), gemma4E4b().runtime.memoryFootprintMb)).resolves.toEqual({ canPin: true });
  });
});
