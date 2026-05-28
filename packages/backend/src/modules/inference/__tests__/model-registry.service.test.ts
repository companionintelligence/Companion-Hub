import { Test, type TestingModule } from '@nestjs/testing';
import { ModelRegistryService } from '../model-registry.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { HardwareProfile } from '@ci-hub/common/types';

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

    describe('Hardware Recommendation Tiers', () => {
      const baseProfile: HardwareProfile = {
        gpu: { available: true, vendor: 'nvidia', model: 'RTX', vramMb: 0, unifiedMemory: false, driverVersion: '550.0', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb: 0, availableMb: 0 },
        cpu: { arch: 'x86_64', cores: 16, model: 'Test CPU' },
        effectiveInferenceMemoryMb: 0,
        tier: 'high',
      };

      it('should recommend 2048GB VRAM models for massive datacenter nodes', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 2097152 },
          ram: { totalMb: 10000000, availableMb: 10000000 },
          effectiveInferenceMemoryMb: 2097152,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('gemma4-3t');
        expect(recs).toContain('qwen3-6-1-5t-q8_0');
      });

      it('should recommend 512GB VRAM models (e.g. DeepSeek V4 Pro)', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 524288 },
          ram: { totalMb: 2000000, availableMb: 2000000 },
          effectiveInferenceMemoryMb: 524288,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('deepseek-v4-pro');
        expect(recs).toContain('qwen3-5-397b-a17b');
      });

      it('should recommend 128GB VRAM models (e.g. MiMo, Qwen 200B)', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 131072 },
          ram: { totalMb: 1000000, availableMb: 1000000 },
          effectiveInferenceMemoryMb: 131072,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('mimo-v2-5-pro');
        expect(recs).toContain('qwen3-6-200b');
      });

      it('should recommend 96GB VRAM models (e.g. GLM 5.1, Mistral Medium)', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 98304 },
          ram: { totalMb: 500000, availableMb: 500000 },
          effectiveInferenceMemoryMb: 98304,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('glm-5-1');
        expect(recs).toContain('mistral-medium-3.5');
      });

      it('should recommend 32GB VRAM models (e.g. QwQ 32B, Kimi V2)', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 32768 },
          ram: { totalMb: 200000, availableMb: 200000 },
          effectiveInferenceMemoryMb: 32768,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('qwq-32b');
        expect(recs).toContain('kimi-k2-think-v2-q3_K_M');
      });

      it('should recommend 24GB VRAM models (e.g. Mistral Small, GPT-OSS 20B)', () => {
        const profile: HardwareProfile = {
          ...baseProfile,
          gpu: { ...baseProfile.gpu, vramMb: 24576 },
          ram: { totalMb: 200000, availableMb: 200000 },
          effectiveInferenceMemoryMb: 24576,
        };
        const recs = service.getRecommendedModelsForHardware('high', profile).map((m) => m.id);
        expect(recs).toContain('mistral-small-3.2');
        expect(recs).toContain('gpt-oss-20b');
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
