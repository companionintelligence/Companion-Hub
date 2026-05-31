import { Test, type TestingModule } from '@nestjs/testing';
import { ModelRegistryService } from '../model-registry.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { CuratedModel, HardwareProfile, HardwareTier } from '@ci-hub/common/types';

describe('ModelRegistryService', () => {
  let service: ModelRegistryService;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ModelRegistryService, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    service = module.get<ModelRegistryService>(ModelRegistryService);
  });

  // ─── S-MM-1: Curated Catalog ──────────────────────────────────────

  describe('Curated catalog (MM-1)', () => {
    it('S-MM-1.1: SHALL include models for LLM, coding, TTS, STT', () => {
      const catalog = service.getCatalog();
      const modalities = new Set(catalog.map((m) => m.modality));
      expect(modalities.has('llm')).toBe(true);
      expect(modalities.has('tts')).toBe(true);
      expect(modalities.has('stt')).toBe(true);
      expect(modalities.has('embedding')).toBe(true);
    });

    it('S-MM-1.5: exposes a 768-dim embedding model recommended on every runnable tier', () => {
      const emb = service.getRecommendedEmbeddingModel('cpu-only');
      expect(emb?.id).toBe('nomic-embed-text');
      expect(emb?.modality).toBe('embedding');
      expect(service.getRecommendedEmbeddingModel('insufficient')).toBeNull();
    });

    it('S-MM-1.2: each model SHALL include minimum hardware requirements', () => {
      const catalog = service.getCatalog();
      for (const model of catalog) {
        expect(model.requirements).toBeDefined();
        expect(typeof model.requirements.minVramMb).toBe('number');
        expect(typeof model.requirements.minRamMb).toBe('number');
        expect(typeof model.requirements.diskMb).toBe('number');
      }
    });

    it('S-MM-1.3: catalog SHALL be filterable by hardware tier', () => {
      const highModels = service.getModelsForTier('high');
      const lowModels = service.getModelsForTier('low');

      // High tier should have more models available
      expect(highModels.length).toBeGreaterThanOrEqual(lowModels.length);

      // Low-tier models should be marked as recommended or available for low tier
      for (const model of lowModels) {
        const rec = model.tiers.low;
        expect(['recommended', 'available']).toContain(rec);
      }
    });

    it('should return empty for insufficient tier', () => {
      const models = service.getModelsForTier('insufficient');
      expect(models).toHaveLength(0);
    });

    it('should return recommended models for each tier', () => {
      const highRec = service.getRecommendedModels('high');
      expect(highRec.length).toBeGreaterThan(0);

      const mediumRec = service.getRecommendedModels('medium');
      expect(mediumRec.length).toBeGreaterThan(0);
    });

    describe('Hardware-aware recommendations (computed from catalog)', () => {
      const GB = 1024;

      const profile = (overrides: {
        vendor?: HardwareProfile['gpu']['vendor'];
        available?: boolean;
        vramMb?: number;
        unifiedMemory?: boolean;
        ramMb: number;
        tier: HardwareTier;
      }): HardwareProfile => ({
        gpu: {
          available: overrides.available ?? true,
          vendor: overrides.vendor ?? 'nvidia',
          model: 'Test GPU',
          vramMb: overrides.vramMb ?? 0,
          unifiedMemory: overrides.unifiedMemory ?? false,
          driverVersion: '550.0',
          runtimeAvailable: true,
        },
        npu: { available: false, model: '' },
        ram: { totalMb: overrides.ramMb, availableMb: overrides.ramMb },
        cpu: { arch: 'x86_64', cores: 16, model: 'Test CPU' },
        effectiveInferenceMemoryMb: overrides.unifiedMemory ? overrides.ramMb : (overrides.vramMb ?? 0),
        tier: overrides.tier,
      });

      const topLlm = (models: CuratedModel[]): CuratedModel | undefined => models.find((m) => m.modality === 'llm');

      it('picks a runnable, size-capped LLM for CPU-only machines (regression: previously returned none)', () => {
        const recs = service.getRecommendedModelsForHardware(
          'cpu-only',
          profile({ available: false, vendor: 'none', ramMb: 32 * GB, tier: 'cpu-only' }),
        );
        const top = topLlm(recs);
        expect(top).toBeDefined();
        expect(top?.backend).toBe('ollama');
        // CPU inference is slow for big models, so the pick is capped to small/fast sizes...
        expect(top?.parameterScale ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14);
        // ...and it actually fits within system-RAM headroom.
        expect(top?.runtime.memoryFootprintMb).toBeLessThanOrEqual(32 * GB * 0.7);
      });

      it('fully uses discrete VRAM with a sizable model that actually fits (24GB GPU)', () => {
        const recs = service.getRecommendedModelsForHardware('high', profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' }));
        const top = topLlm(recs);
        expect(top).toBeDefined();
        // A 24GB GPU should land on a substantial (~30B-class) model, not a tiny one…
        expect(top?.parameterScale ?? 0).toBeGreaterThanOrEqual(24);
        expect(top?.runtime.quantization).not.toBe('q3_K_M');
        // …and the pick must genuinely fit the VRAM budget.
        expect(top?.runtime.memoryFootprintMb).toBeLessThanOrEqual(24 * GB * 0.9);
      });

      it('sizes a discrete GPU by its VRAM, not system RAM (same GPU, different RAM → same pick)', () => {
        const lessRam = service.getRecommendedModelsForHardware('high', profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' }));
        const moreRam = service.getRecommendedModelsForHardware('high', profile({ vramMb: 24 * GB, ramMb: 64 * GB, tier: 'high' }));
        expect(topLlm(lessRam)?.id).toBe(topLlm(moreRam)?.id);
      });

      it('sizes a unified-memory Mac to a fraction of total RAM (16GB → ~12B, not 8B)', () => {
        const recs = service.getRecommendedModelsForHardware(
          'high',
          profile({ vendor: 'apple', unifiedMemory: true, vramMb: 16 * GB, ramMb: 16 * GB, tier: 'high' }),
        );
        const top = topLlm(recs);
        expect(top?.parameterScale ?? 0).toBeGreaterThanOrEqual(12);
        expect(top?.runtime.memoryFootprintMb).toBeLessThanOrEqual(16 * GB * 0.7);
      });

      it('scales the pick up with the budget (bigger VRAM → bigger model)', () => {
        const gpu16 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 16 * GB, ramMb: 32 * GB, tier: 'high' })));
        const gpu24 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' })));
        const gpu48 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 48 * GB, ramMb: 128 * GB, tier: 'high' })));
        expect(gpu24?.parameterScale ?? 0).toBeGreaterThan(gpu16?.parameterScale ?? 0);
        expect(gpu48?.parameterScale ?? 0).toBeGreaterThan(gpu24?.parameterScale ?? 0);
      });

      it('still recommends a massive model for datacenter-class VRAM', () => {
        const recs = service.getRecommendedModelsForHardware('high', profile({ vramMb: 2097152, ramMb: 10000000, tier: 'high' }));
        const top = topLlm(recs);
        expect(top?.parameterScale ?? 0).toBeGreaterThanOrEqual(500);
        expect(top?.runtime.quantization).not.toBe('q3_K_M');
      });

      it('never recommends an LLM that is not browsable for that tier (recommended ⊆ getModelsForTier)', () => {
        const scenarios: Array<{ tier: HardwareTier; hw: HardwareProfile }> = [
          { tier: 'high', hw: profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' }) },
          { tier: 'medium', hw: profile({ vramMb: 8 * GB, ramMb: 16 * GB, tier: 'medium' }) },
          { tier: 'low', hw: profile({ vramMb: 6 * GB, ramMb: 16 * GB, tier: 'low' }) },
          { tier: 'cpu-only', hw: profile({ available: false, vendor: 'none', ramMb: 32 * GB, tier: 'cpu-only' }) },
        ];
        for (const { tier, hw } of scenarios) {
          const browsableIds = new Set(service.getModelsForTier(tier).map((m) => m.id));
          const recommendedLlms = service.getRecommendedModelsForHardware(tier, hw).filter((m) => m.modality === 'llm');
          expect(recommendedLlms.length).toBeGreaterThan(0);
          for (const m of recommendedLlms) {
            expect(browsableIds.has(m.id)).toBe(true);
          }
        }
      });

      it('returns no models for an insufficient tier', () => {
        expect(
          service.getRecommendedModelsForHardware('insufficient', profile({ available: false, vendor: 'none', ramMb: 4 * GB, tier: 'insufficient' })),
        ).toEqual([]);
      });

      // ─── Expanded hardware ladder (2GB → 2048GB VRAM) ───────────────────
      const VRAM_LADDER_GB = [2, 4, 8, 12, 16, 24, 32, 64, 96, 128, 256, 512, 1024, 2048];

      it('recommends a runnable, non-decreasing model across the full VRAM ladder (2GB → 2048GB)', () => {
        let prevParams = -1;
        for (const vramGb of VRAM_LADDER_GB) {
          const ramGb = Math.max(8, vramGb * 2); // RAM tracks VRAM on real machines
          const hw = profile({ vramMb: vramGb * GB, ramMb: ramGb * GB, tier: 'high' });
          const top = topLlm(service.getRecommendedModelsForHardware('high', hw));
          expect(top, `VRAM ${vramGb}GB should yield a runnable LLM`).toBeDefined();
          // Fits dedicated VRAM (GPU-resident) or, for a sub-minimum GPU, system RAM (CPU fallback).
          const fitsVram = (top?.runtime.memoryFootprintMb ?? Number.POSITIVE_INFINITY) <= vramGb * GB * 0.9;
          const fitsRam = (top?.runtime.memoryFootprintMb ?? Number.POSITIVE_INFINITY) <= ramGb * GB * 0.7;
          expect(fitsVram || fitsRam, `VRAM ${vramGb}GB pick must fit VRAM or RAM`).toBe(true);
          // Capability never regresses as the budget grows.
          expect(top?.parameterScale ?? 0, `VRAM ${vramGb}GB should not regress capability`).toBeGreaterThanOrEqual(prevParams);
          prevParams = top?.parameterScale ?? 0;
        }
      });

      it('falls back to a CPU/RAM model when the GPU is too small to hold any model (2GB VRAM + RAM)', () => {
        const hw = profile({ vramMb: 2 * GB, ramMb: 32 * GB, tier: 'cpu-only' });
        const top = topLlm(service.getRecommendedModelsForHardware('cpu-only', hw));
        expect(top).toBeDefined();
        expect(top?.parameterScale ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(14); // CPU speed cap
        expect(top?.runtime.memoryFootprintMb).toBeLessThanOrEqual(32 * GB * 0.7);
      });

      it('recommends the real default (q4_K_M) build and never overflows the VRAM budget', () => {
        // The catalog lists only the bare `model:size` tag each model actually ships, which is the
        // q4_K_M default pull — so every pick is real/installable and must fit the budget.
        for (const vramGb of [8, 12, 16, 24, 32, 64, 96]) {
          const top = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: vramGb * GB, ramMb: vramGb * 2 * GB, tier: 'high' })));
          expect(top, `VRAM ${vramGb}GB should yield a runnable LLM`).toBeDefined();
          expect(top?.runtime.quantization).toBe('q4_K_M');
          expect(top?.runtime.memoryFootprintMb, `VRAM ${vramGb}GB pick must fit VRAM`).toBeLessThanOrEqual(vramGb * GB * 0.9);
        }
      });

      // ─── Frontier model coverage (installer recommend/include set) ──────
      // Every id here is verified to exist on ollama.com/library (the catalog lists only real,
      // pullable model:size tags). Earlier this list held speculative models (Kimi K2.6, DeepSeek V4,
      // GLM-5.1, MiniMax-M2.7, Mistral Medium 3.5, …) that 404 on ollama.com — they were removed.
      const FRONTIER_MODEL_IDS = [
        'gemma4-31b', // Gemma 4 31B
        'qwen3-6-35b', // Qwen 3.6 35B (MoE)
        'qwen3-5-122b', // Qwen 3.5 122B
        'qwen3-235b', // Qwen 3 235B
        'nemotron3-33b', // Nemotron 3 33B
        'nemotron-3-super-120b', // NVIDIA Nemotron 3 Super 120B (MoE)
        'gpt-oss-120b', // gpt-oss 120B
        'gpt-oss-20b', // gpt-oss 20B
        'qwq-32b', // QwQ 32B
        'deepseek-r1-671b', // DeepSeek R1 671B
        'deepseek-r1-70b', // DeepSeek R1 70B
        'deepseek-coder-v2-236b', // DeepSeek Coder V2 236B
        'llama3-1-405b', // Llama 3.1 405B
        'llama3-3-70b', // Llama 3.3 70B
        'llama4-128x17b', // Llama 4 Maverick (128x17B MoE)
        'llama4-16x17b', // Llama 4 Scout (16x17B MoE)
        'mistral-large-123b', // Mistral Large 123B
        'mixtral-8x22b', // Mixtral 8x22B
        'minimax-m2-community-230b', // MiniMax M2 230B (community upload)
      ];

      it('spans size classes (small/medium/large) when the hardware can run a range', () => {
        const recs = service
          .getRecommendedModelsForHardware('high', profile({ vramMb: 96 * GB, ramMb: 192 * GB, tier: 'high' }))
          .filter((m) => m.modality === 'llm');
        const classOf = (p?: number) => ((p ?? 0) > 70 ? 'large' : (p ?? 0) > 14 ? 'medium' : 'small');
        const classes = new Set(recs.map((m) => classOf(m.parameterScale)));
        // index 0 is still the single best (largest) model for auto-install
        expect(recs[0]?.parameterScale ?? 0).toBeGreaterThan(70);
        // the list covers more than one size class instead of clustering at the top
        expect(classes.size).toBeGreaterThanOrEqual(2);
        // and surfaces a genuinely smaller option
        expect(classes.has('small') || classes.has('medium')).toBe(true);
      });

      it('includes every listed frontier model in the catalog and makes each installable on a top-tier box', () => {
        const workstationBudgetMb = 2048 * GB * 0.9;
        const highTierIds = new Set(service.getModelsForTier('high').map((m) => m.id));
        for (const id of FRONTIER_MODEL_IDS) {
          const model = service.getCuratedModel(id);
          expect(model, `frontier model ${id} should exist in the catalog`).toBeDefined();
          expect(model?.modality).toBe('llm');
          expect(model?.parameterScale, `frontier model ${id} should declare a parameter scale`).toBeGreaterThan(0);
          // Runs on a top-tier workstation and is browsable/installable in the high tier.
          expect(model?.runtime.memoryFootprintMb ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(workstationBudgetMb);
          expect(highTierIds.has(id), `frontier model ${id} should be installable in the high tier`).toBe(true);
        }
      });
    });

    it('should filter by modality', () => {
      const llms = service.getModelsByModality('llm');
      expect(llms.length).toBeGreaterThan(0);
      for (const m of llms) {
        expect(m.modality).toBe('llm');
      }
    });

    it('should filter by backend', () => {
      const ollamaModels = service.getModelsByBackend('ollama');
      expect(ollamaModels.length).toBeGreaterThan(0);
      for (const m of ollamaModels) {
        expect(m.backend).toBe('ollama');
      }
    });
  });

  // ─── S-MM-2: Model State Tracking ─────────────────────────────────

  describe('Model state tracking (MM-2)', () => {
    it('S-MM-2.1: SHALL track model lifecycle states', () => {
      service.trackModel('phi-4-mini', 'pulling');
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('pulling');

      service.updateModelState('phi-4-mini', 'pulled');
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('pulled');

      service.updateModelState('phi-4-mini', 'loading');
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('loading');

      service.updateModelState('phi-4-mini', 'loaded');
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('loaded');
    });

    it('S-MM-2.2: SHALL track pull progress', () => {
      service.trackModel('phi-4-mini', 'pulling');
      service.updatePullProgress('phi-4-mini', 50);
      expect(service.getTrackedModel('phi-4-mini')?.pullProgress).toBe(50);
    });

    it('should handle error state', () => {
      service.trackModel('phi-4-mini', 'pulling');
      service.updateModelState('phi-4-mini', 'error', 'Network error');
      const tracked = service.getTrackedModel('phi-4-mini');
      expect(tracked?.state).toBe('error');
      expect(tracked?.errorMessage).toBe('Network error');
    });
  });

  // ─── S-MM-3: Pinning ──────────────────────────────────────────────

  describe('Model pinning (MM-3)', () => {
    it('S-MM-3.1: SHALL support pinning models', () => {
      service.trackModel('phi-4-mini', 'loaded');
      service.pinModel('phi-4-mini');
      expect(service.getTrackedModel('phi-4-mini')?.pinned).toBe(true);
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('pinned');
    });

    it('S-MM-3.2: pinned models SHALL NOT be in eviction candidates', () => {
      service.trackModel('phi-4-mini', 'loaded');
      service.pinModel('phi-4-mini');

      const candidates = service.getEvictionCandidates();
      expect(candidates.find((c) => c.catalogId === 'phi-4-mini')).toBeUndefined();
    });

    it('should unpin models', () => {
      service.trackModel('phi-4-mini', 'loaded');
      service.pinModel('phi-4-mini');
      service.unpinModel('phi-4-mini');

      expect(service.getTrackedModel('phi-4-mini')?.pinned).toBe(false);
      expect(service.getTrackedModel('phi-4-mini')?.state).toBe('loaded');
    });

    it('should track default pinned models', () => {
      const defaults = service.getDefaultPinnedModels('medium');
      expect(defaults.every((m) => m.runtime.pinnedByDefault)).toBe(true);
    });
  });

  // ─── Eviction Candidates ──────────────────────────────────────────

  describe('Eviction candidates', () => {
    it('should sort by LRU (oldest first)', () => {
      service.trackModel('model-a', 'loaded');
      service.trackModel('model-b', 'loaded');
      const modelA = service.getTrackedModel('model-a');
      const modelB = service.getTrackedModel('model-b');
      if (modelA) modelA.lastUsedAt = 100;
      if (modelB) modelB.lastUsedAt = 200;

      const candidates = service.getEvictionCandidates();
      expect(candidates[0].catalogId).toBe('model-a');
    });

    it('should exclude pinned from eviction candidates', () => {
      service.trackModel('model-a', 'loaded');
      service.pinModel('model-a');

      service.trackModel('model-b', 'loaded');

      const candidates = service.getEvictionCandidates();
      expect(candidates.find((c) => c.catalogId === 'model-a')).toBeUndefined();
      expect(candidates.find((c) => c.catalogId === 'model-b')).toBeDefined();
    });
  });

  // ─── Usage Recording ──────────────────────────────────────────────

  describe('Usage recording', () => {
    it('should record usage for LRU', () => {
      service.trackModel('phi-4-mini', 'loaded');
      service.recordUsage('phi-4-mini');

      const tracked = service.getTrackedModel('phi-4-mini');
      expect(tracked?.requestCount).toBe(1);
      expect(tracked?.lastUsedAt).toBeDefined();
    });
  });
});
