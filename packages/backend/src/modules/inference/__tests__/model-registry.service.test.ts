import { Test, type TestingModule } from '@nestjs/testing';
import { ModelRegistryService } from '../model-registry.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { CuratedModel, HardwareProfile, HardwareTier, HostPlatform } from '@ci-hub/common/types';

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

    it('returns null for vision recommendations on an insufficient tier', () => {
      expect(service.getRecommendedVisionModel('insufficient')).toBeNull();
    });

    it('returns a vision-capable LLM for runnable tiers that have one', () => {
      const vision = service.getRecommendedVisionModel('high');
      expect(vision).not.toBeNull();
      expect(vision?.modality).toBe('llm');
      expect(vision?.metadata?.capabilities?.vision).toBe(true);
      expect(service.getModelsForTier('high').some((model) => model.id === vision?.id)).toBe(true);
    });

    it('ranks vision recommendations best-first instead of relying on catalog order', () => {
      const visionCandidates = service
        .getModelsForTier('high')
        .filter((model) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true);

      expect(visionCandidates.length).toBeGreaterThan(0);

      const expectedBest = [...visionCandidates].sort((a, b) => {
        const intel = (b.metadata?.intelligenceIndex ?? 0) - (a.metadata?.intelligenceIndex ?? 0);
        if (intel !== 0) return intel;
        const aSubQ4 = (a.runtime.quantization ?? '') === 'q3_K_M' ? 1 : 0;
        const bSubQ4 = (b.runtime.quantization ?? '') === 'q3_K_M' ? 1 : 0;
        if (aSubQ4 !== bSubQ4) return aSubQ4 - bSubQ4;
        const params = (b.parameterScale ?? 0) - (a.parameterScale ?? 0);
        if (params !== 0) return params;
        const rank = (q: string | undefined) => ({ q8_0: 6, q6_K: 5, q5_K_M: 4, q4_K_M: 3, fp16: 2, q3_K_M: 1 })[q ?? ''] ?? 0;
        return rank(b.runtime.quantization) - rank(a.runtime.quantization);
      })[0];

      expect(service.getRecommendedVisionModel('high')?.id).toBe(expectedBest?.id);
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
        arch?: HardwareProfile['cpu']['arch'];
        platform?: HostPlatform;
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
        cpu: { arch: overrides.arch ?? 'x86_64', cores: 16, model: 'Test CPU' },
        effectiveInferenceMemoryMb: overrides.unifiedMemory ? overrides.ramMb : (overrides.vramMb ?? 0),
        tier: overrides.tier,
        ...(overrides.platform ? { os: { platform: overrides.platform, name: overrides.platform, version: '' } } : {}),
      });

      const topLlm = (models: CuratedModel[]): CuratedModel | undefined => models.find((m) => m.modality === 'llm');

      it('filters local recommendations by host platform across macOS, Linux, and Windows', () => {
        const linux = service.getRecommendedModelsForHardware('high', profile({ platform: 'linux', vramMb: 48 * GB, ramMb: 128 * GB, tier: 'high' }));
        const windows = service.getRecommendedModelsForHardware(
          'high',
          profile({ platform: 'win32', vramMb: 48 * GB, ramMb: 128 * GB, tier: 'high' }),
        );
        const macos = service.getRecommendedModelsForHardware(
          'high',
          profile({ platform: 'darwin', vendor: 'apple', unifiedMemory: true, arch: 'arm64', ramMb: 64 * GB, tier: 'high' }),
        );

        const assertPlatform = (models: CuratedModel[], platform: HostPlatform) => {
          for (const model of models) {
            expect(model.requirements.supportedPlatforms, `${model.id} platform`).toContain(platform);
          }
        };
        assertPlatform(linux, 'linux');
        assertPlatform(windows, 'win32');
        assertPlatform(macos, 'darwin');

        expect(linux.some((m) => m.backend === 'vllm' && !m.id.endsWith('-mlx'))).toBe(true);
        expect(windows.some((m) => m.backend === 'vllm' && !m.id.endsWith('-mlx'))).toBe(true);
        expect(linux.some((m) => m.backend === 'omlx')).toBe(false);
        expect(windows.some((m) => m.backend === 'omlx')).toBe(false);
        expect(macos.some((m) => m.backend === 'omlx')).toBe(true);
        expect(macos.some((m) => m.backend === 'vllm' && !m.id.endsWith('-mlx'))).toBe(false);
      });

      it('keeps cross-platform host-served rows available only for explicit remote setup', () => {
        const linux = profile({ platform: 'linux', vramMb: 48 * GB, ramMb: 128 * GB, tier: 'high' });
        const local = service.getModelsForHardware('high', linux);
        const remoteSetup = service.getModelsForHardware('high', linux, { includeRemoteHostBackends: true });

        expect(local.some((m) => m.backend === 'omlx')).toBe(false);
        expect(remoteSetup.some((m) => m.backend === 'omlx')).toBe(true);
      });

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

      // The default (index 0) is the most capable model that fits — measured by Artificial Analysis
      // Intelligence Index, not parameter count (a smarter 27B can beat a weaker 70B).
      const intel = (m: CuratedModel | undefined) => m?.metadata?.intelligenceIndex ?? 0;

      it('picks the highest-intelligence model that fits a unified-memory Mac (16GB)', () => {
        const recs = service
          .getRecommendedModelsForHardware('high', profile({ vendor: 'apple', unifiedMemory: true, vramMb: 16 * GB, ramMb: 16 * GB, tier: 'high' }))
          .filter((m) => m.modality === 'llm');
        const top = recs[0];
        expect(top).toBeDefined();
        // index 0 is the highest Intelligence Index among its engine's fitting picks (the list is grouped
        // per engine, each best-first; another engine's row can outscore the first engine's best)…
        expect(intel(top)).toBe(Math.max(...recs.filter((m) => m.backend === top?.backend).map(intel)));
        // …and it actually fits the unified-memory budget.
        expect(top?.runtime.memoryFootprintMb).toBeLessThanOrEqual(16 * GB * 0.7);
      });

      it('excludes bandwidth-bound large dense models on a shared-memory APU (prefers MoE / low active params)', () => {
        const activeOf = (m: CuratedModel) => m.activeParameterScale ?? m.parameterScale ?? Number.POSITIVE_INFINITY;
        // Same huge memory budget, two memory architectures.
        const discrete = service.getRecommendedModelsForHardware(
          'high',
          profile({ vendor: 'amd', unifiedMemory: false, vramMb: 128 * GB, ramMb: 128 * GB, tier: 'high' }),
        );
        const apu = service
          .getRecommendedModelsForHardware('high', profile({ vendor: 'amd', unifiedMemory: true, vramMb: 128 * GB, ramMb: 128 * GB, tier: 'high' }))
          .filter((m) => m.modality === 'llm');

        // Discrete VRAM: no per-token bandwidth penalty, so the high-intelligence dense 27B is the default
        // (Qwen 3.8 27B since the 2026-09-16 Intelligence Index v4.3 refresh; it was Qwen 3.6 27B before).
        expect(topLlm(discrete)?.id).toBe('qwen3-8-27b');

        // Shared-memory APU: the dense 27Bs "fit" the budget but are bandwidth-bound, so they are excluded…
        expect(apu.length).toBeGreaterThan(0);
        expect(apu.some((m) => m.id === 'qwen3-8-27b' || m.id === 'qwen3-6-27b')).toBe(false);
        // …and every pick is within the shared-memory active-param cap (MoE like qwen3:30b-a3b qualify).
        for (const m of apu) {
          expect(activeOf(m)).toBeLessThanOrEqual(14);
        }
      });

      it('does NOT apply the cap to ARM unified memory (Apple Silicon / NVIDIA Grace are high-bandwidth)', () => {
        // Same shared-memory budget as the AMD APU above, but on an arm64 unified-memory part:
        // the cap is x86-UMA-only (gated on cpu.arch), so the dense 27B remains a valid default.
        const apple = service.getRecommendedModelsForHardware(
          'high',
          profile({ vendor: 'apple', unifiedMemory: true, arch: 'arm64', vramMb: 128 * GB, ramMb: 128 * GB, tier: 'high' }),
        );
        expect(topLlm(apple)?.id).toBe('qwen3-8-27b');
      });

      it('never lowers the picked model intelligence as the budget grows', () => {
        const gpu16 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 16 * GB, ramMb: 32 * GB, tier: 'high' })));
        const gpu24 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' })));
        const gpu48 = topLlm(service.getRecommendedModelsForHardware('high', profile({ vramMb: 48 * GB, ramMb: 128 * GB, tier: 'high' })));
        // A larger budget only adds candidates, so the best-fit's intelligence is non-decreasing.
        expect(intel(gpu24)).toBeGreaterThanOrEqual(intel(gpu16));
        expect(intel(gpu48)).toBeGreaterThanOrEqual(intel(gpu24));
      });

      it('picks the highest-intelligence catalog model for datacenter-class VRAM', () => {
        const recs = service.getRecommendedModelsForHardware('high', profile({ vramMb: 2097152, ramMb: 10000000, tier: 'high' }));
        const top = topLlm(recs);
        const maxCatalogIntel = Math.max(
          ...service
            .getCatalog()
            .filter((m) => m.modality === 'llm')
            .map((m) => m.metadata?.intelligenceIndex ?? 0),
        );
        // Everything fits, so the default is the single most capable model in the catalog.
        expect(intel(top)).toBe(maxCatalogIntel);
        expect(top?.runtime.quantization).not.toBe('q3_K_M');
      });

      it('never recommends an LLM that is not browsable for that tier (recommended ⊆ getModelsForTier)', () => {
        const scenarios: Array<{ tier: HardwareTier; hw: HardwareProfile }> = [
          { tier: 'high', hw: profile({ vramMb: 24 * GB, ramMb: 32 * GB, tier: 'high' }) },
          { tier: 'medium', hw: profile({ vramMb: 8 * GB, ramMb: 16 * GB, tier: 'medium' }) },
          { tier: 'low', hw: profile({ vramMb: 6 * GB, ramMb: 16 * GB, tier: 'low' }) },
          { tier: 'cpu-only', hw: profile({ available: false, vendor: 'none', ramMb: 32 * GB, tier: 'cpu-only' }) },
          { tier: 'high', hw: profile({ vendor: 'apple', unifiedMemory: true, arch: 'arm64', vramMb: 64 * GB, ramMb: 64 * GB, tier: 'high' }) },
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

      // #1103: vLLM has no CPU serving path, so the system-RAM fallback must never resurrect
      // vLLM models the VRAM fit check correctly rejected. On an 8GB card with plenty of RAM the
      // old behavior recommended (and onboarding preselected) Qwen3-8B — an 18GB bf16 footprint
      // that OOMs immediately.
      it('never recommends a vLLM model that exceeds the VRAM budget (no CPU-RAM fallback for vLLM)', () => {
        const vramMb = 8 * GB;
        const hw = profile({ vramMb, ramMb: 62 * GB, tier: 'medium' });
        const vllmPicks = service.getRecommendedModelsForHardware('medium', hw).filter((m) => m.backend === 'vllm');
        for (const m of vllmPicks) {
          expect(m.runtime.memoryFootprintMb, `${m.id} must fit the VRAM budget`).toBeLessThanOrEqual(vramMb * 0.9);
        }
        // No curated vLLM model fits an 8GB card today, so the honest recommendation is none —
        // while the Ollama picks for the same box remain available.
        expect(vllmPicks).toEqual([]);
        expect(service.getRecommendedModelsForHardware('medium', hw).some((m) => m.backend === 'ollama' && m.modality === 'llm')).toBe(true);
      });

      it('still recommends fitting vLLM models on a large NVIDIA card', () => {
        const vramMb = 48 * GB;
        const vllmPicks = service
          .getRecommendedModelsForHardware('high', profile({ vramMb, ramMb: 128 * GB, tier: 'high' }))
          .filter((m) => m.backend === 'vllm');
        expect(vllmPicks.length).toBeGreaterThan(0);
        for (const m of vllmPicks) {
          expect(m.runtime.memoryFootprintMb).toBeLessThanOrEqual(vramMb * 0.9);
        }
      });

      // vLLM-Metal (the catalog's `-mlx` rows) is the only vLLM path on Apple Silicon — see
      // VllmBackend.getComposeConfig's `apple` branch, which declines the CUDA/Docker path outright.
      it('recommends oMLX models on Apple Silicon, sized to unified memory', () => {
        const smallMac = service
          .getRecommendedModelsForHardware('medium', profile({ vendor: 'apple', unifiedMemory: true, arch: 'arm64', ramMb: 16 * GB, tier: 'medium' }))
          .filter((m) => m.backend === 'omlx');
        for (const m of smallMac) {
          expect(m.id, `${m.id} must be an MLX row`).toMatch(/-mlx$/);
          expect(m.runtime.memoryFootprintMb).toBeLessThanOrEqual(16 * GB * 0.7);
        }

        // A large-unified-memory Mac (M-series Max/Ultra) can fit the 70B MLX row too.
        const bigMac = service
          .getRecommendedModelsForHardware('high', profile({ vendor: 'apple', unifiedMemory: true, arch: 'arm64', ramMb: 64 * GB, tier: 'high' }))
          .filter((m) => m.backend === 'omlx');
        expect(bigMac.length).toBeGreaterThan(0);
        expect(bigMac.some((m) => m.id === 'llama3-3-70b-mlx')).toBe(true);
        for (const m of bigMac) {
          expect(m.runtime.memoryFootprintMb).toBeLessThanOrEqual(64 * GB * 0.7);
        }
      });

      // #1103's regression, mirrored for Apple: when every MLX row is too big for the unified-memory
      // budget, the CPU/RAM fallback in selectLlmsForHardware must not resurrect one anyway — MLX
      // rows are gated to `gpuVendors: ['apple']` (never 'cpu'), so the fallback's `vendor: 'cpu'`
      // pick correctly finds nothing, same as the CUDA vLLM rows' `vendor: 'nvidia'` gate above.
      // The 2026-08-24 MLX expansion added catalog rows down to 270M params (~0.2GB — actually a
      // touch smaller than Ollama's own smallest, gemma3-270m's q4_K_M build), so no *real* Mac RAM
      // size leaves every MLX row too big while Ollama still has a fit; this uses a synthetic
      // sub-real RAM purely to exercise the fallback-rejection path itself, not plausible hardware.
      it('never recommends an oMLX model that exceeds the unified-memory budget', () => {
        const ramMb = 256;
        const hw = profile({ vendor: 'apple', unifiedMemory: true, arch: 'arm64', ramMb, tier: 'low' });
        const omlxPicks = service.getRecommendedModelsForHardware('low', hw).filter((m) => m.backend === 'omlx');
        expect(omlxPicks).toEqual([]);
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

      // Index 0 is what app bootstrap auto-installs, and on the smallest profiles one catalog footprint
      // decides it. A figure for gemma4-e2b derived from e4b's measurement (2,925 MB, not measured) made
      // it index 0 on every 4 GB card: a 7.2 GB download in place of nemotron-3-nano-4b's 2.8 GB, which
      // the load estimate then refused on that card (4,977 MB at 4096 by the catalog alone, against
      // 3,584). These pin the default so a footprint change that moves it has to say so here.
      describe('keeps the auto-installed default on the smallest profiles', () => {
        const TIERS: HardwareTier[] = ['cpu-only', 'low', 'medium', 'high'];

        it.each(
          TIERS.flatMap((tier) => (['nvidia', 'amd'] as const).map((vendor) => [vendor, tier] as const)),
        )('a 4 GB %s card at the %s tier installs nemotron-3-nano-4b', (vendor, tier) => {
          const recs = service.getRecommendedModelsForHardware(tier, profile({ vendor, vramMb: 4 * GB, ramMb: 32 * GB, platform: 'linux', tier }));

          expect(recs[0]?.id).toBe('nemotron-3-nano-4b');
          expect(recs.map((m) => m.id)).not.toContain('gemma4-e2b');
        });

        const EIGHT_GB_RAM: Array<[string, Omit<Parameters<typeof profile>[0], 'tier'>]> = [
          ['a CPU-only machine', { available: false, vendor: 'none', ramMb: 8 * GB, platform: 'linux' }],
          ['an AMD APU', { vendor: 'amd', unifiedMemory: true, ramMb: 8 * GB, platform: 'linux' }],
          ['an Apple Silicon Mac', { vendor: 'apple', unifiedMemory: true, arch: 'arm64', ramMb: 8 * GB, platform: 'darwin' }],
        ];

        // gemma4-e4b's measured 4,362 MB fits the 5,734 MB an 8 GB machine gives a model, so it is now
        // offered there — second, below the default, which does not move.
        it.each(
          TIERS.flatMap((tier) => EIGHT_GB_RAM.map(([name, hw]) => [name, tier, hw] as const)),
        )('%s with 8 GB of RAM at the %s tier installs qwen3-5-4b and offers gemma4-e4b after it', (_name, tier, hw) => {
          const ids = service.getRecommendedModelsForHardware(tier, profile({ ...hw, tier })).map((m) => m.id);

          expect(ids.slice(0, 2)).toEqual(['qwen3-5-4b', 'gemma4-e4b']);
          expect(ids).not.toContain('gemma4-e2b');
        });
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

      it('leads with the highest-intelligence pick and still spans multiple size classes', () => {
        const recs = service
          .getRecommendedModelsForHardware('high', profile({ vramMb: 96 * GB, ramMb: 192 * GB, tier: 'high' }))
          .filter((m) => m.modality === 'llm');
        const classOf = (p?: number) => ((p ?? 0) > 70 ? 'large' : (p ?? 0) > 14 ? 'medium' : 'small');
        const classes = new Set(recs.map((m) => classOf(m.parameterScale)));
        // index 0 is the most capable (highest Intelligence Index) model that fits — the auto-install default.
        expect(intel(recs[0])).toBe(Math.max(...recs.map(intel)));
        // the list still covers more than one size class instead of clustering at one size.
        expect(classes.size).toBeGreaterThanOrEqual(2);
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
      expect(candidates[0]?.catalogId).toBe('model-a');
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
