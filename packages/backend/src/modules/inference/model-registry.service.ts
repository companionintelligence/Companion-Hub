import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type {
  CuratedModel,
  HardwareProfile,
  HardwareTier,
  InferenceBackendType,
  ModelModality,
  ModelState,
  TrackedModel,
} from '@ci-hub/common/types';
import { CURATED_MODELS } from './catalog/curated-models';

const LLM_RECOMMENDATION_TABLE: Array<{ minVramMb: number; minRamMb: number; recommendedModelIds: string[] }> = [
  { minVramMb: 49152, minRamMb: 131072, recommendedModelIds: ['gemma4-27b-fp16', 'nemotron3-22b-fp16'] },
  { minVramMb: 32768, minRamMb: 98304, recommendedModelIds: ['gemma4-27b-q8_0', 'nemotron3-22b-q8_0'] },
  { minVramMb: 24576, minRamMb: 65536, recommendedModelIds: ['gemma4-27b', 'nemotron3-22b'] },
  { minVramMb: 16384, minRamMb: 32768, recommendedModelIds: ['nemotron3-22b-q6_K', 'qwen3-6-20b'] },
  { minVramMb: 12288, minRamMb: 32768, recommendedModelIds: ['qwen3-6-20b', 'gemma4-12b-q8_0'] },
  { minVramMb: 8192, minRamMb: 24576, recommendedModelIds: ['gemma4-12b', 'nemotron3-8b-q8_0'] },
  { minVramMb: 6144, minRamMb: 16384, recommendedModelIds: ['gemma4-12b-q3_K_M', 'qwen3-6-8b-q6_K'] },
  { minVramMb: 4096, minRamMb: 16384, recommendedModelIds: ['qwen3-6-8b', 'nemotron3-8b'] },
  { minVramMb: 0, minRamMb: 8192, recommendedModelIds: ['gemma4-4b', 'qwen3-6-8b-q3_K_M'] },
  { minVramMb: 0, minRamMb: 4096, recommendedModelIds: ['gemma4-4b-q3_K_M'] },
];

@Injectable()
export class ModelRegistryService implements OnModuleInit {
  /** Tracked model states (in-memory only; does not survive process restarts) */
  private readonly trackedModels = new Map<string, TrackedModel>();

  constructor(private readonly logger: LoggerService) {}

  onModuleInit() {
    this.logger.info(`[ModelRegistry] Loaded ${CURATED_MODELS.length} curated models`);
  }

  /** Get the curated catalog */
  getCatalog(): CuratedModel[] {
    return CURATED_MODELS;
  }

  /** Filter catalog by hardware tier */
  getModelsForTier(tier: HardwareTier): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    return CURATED_MODELS.filter((m) => {
      const rec = m.tiers[tierKey as keyof typeof m.tiers];
      return rec === 'recommended' || rec === 'available';
    });
  }

  /** Get recommended models for a tier (default pulls) */
  getRecommendedModels(tier: HardwareTier): CuratedModel[] {
    const tierKey = tier === 'cpu-only' ? 'cpuOnly' : tier;
    if (tier === 'insufficient') return [];
    return CURATED_MODELS.filter((m) => m.tiers[tierKey as keyof typeof m.tiers] === 'recommended');
  }

  /** Get hardware-aware recommendations with VRAM/RAM sizing table for Ollama LLMs */
  getRecommendedModelsForHardware(tier: HardwareTier, profile: HardwareProfile): CuratedModel[] {
    const tierRecommended = this.getRecommendedModels(tier);
    const nonOllamaLlmRecommended = tierRecommended.filter((m) => m.backend !== 'ollama' || m.modality !== 'llm');
    const ollamaLlmCandidates = this.getModelsForTier(tier).filter((m) => m.backend === 'ollama' && m.modality === 'llm');

    if (ollamaLlmCandidates.length === 0) {
      return tierRecommended;
    }

    const effectiveVramMb =
      profile.gpu.available && !profile.gpu.unifiedMemory ? profile.gpu.vramMb : profile.gpu.unifiedMemory ? profile.ram.totalMb : 0;
    const effectiveRamMb = profile.ram.totalMb;

    const tableMatch = LLM_RECOMMENDATION_TABLE.find((row) => effectiveVramMb >= row.minVramMb && effectiveRamMb >= row.minRamMb) ??
      LLM_RECOMMENDATION_TABLE[LLM_RECOMMENDATION_TABLE.length - 1] ?? { minVramMb: 0, minRamMb: 0, recommendedModelIds: [] };

    const tableRecommendedLlms = tableMatch.recommendedModelIds
      .map((id) => ollamaLlmCandidates.find((m) => m.id === id))
      .filter((m): m is CuratedModel => !!m)
      .filter((m) => this.canRunOnHardware(m, profile));

    if (tableRecommendedLlms.length > 0) {
      return [...tableRecommendedLlms, ...nonOllamaLlmRecommended];
    }

    const fallbackLlms = tierRecommended
      .filter((m) => m.backend === 'ollama' && m.modality === 'llm')
      .filter((m) => this.canRunOnHardware(m, profile));

    return [...fallbackLlms, ...nonOllamaLlmRecommended];
  }

  /** Get default models to pin for a tier */
  getDefaultPinnedModels(tier: HardwareTier): CuratedModel[] {
    return this.getRecommendedModels(tier).filter((m) => m.runtime.pinnedByDefault);
  }

  private canRunOnHardware(model: CuratedModel, profile: HardwareProfile): boolean {
    const runtimeVramMb = profile.gpu.unifiedMemory ? profile.ram.totalMb : profile.gpu.available ? profile.gpu.vramMb : 0;
    const gpuVendor = profile.gpu.available && profile.gpu.vendor !== 'none' ? profile.gpu.vendor : 'cpu';
    return (
      model.requirements.minRamMb <= profile.ram.totalMb &&
      model.requirements.minVramMb <= runtimeVramMb &&
      model.requirements.gpuVendors.includes(gpuVendor)
    );
  }

  /** Get models by modality */
  getModelsByModality(modality: ModelModality): CuratedModel[] {
    return CURATED_MODELS.filter((m) => m.modality === modality);
  }

  /** Get models for a specific backend */
  getModelsByBackend(backend: InferenceBackendType): CuratedModel[] {
    return CURATED_MODELS.filter((m) => m.backend === backend);
  }

  /** Look up a curated model by ID */
  getCuratedModel(modelId: string): CuratedModel | undefined {
    return CURATED_MODELS.find((m) => m.id === modelId);
  }

  // ─── Tracked Model State ──────────────────────────────────────────────

  /** Get all tracked models */
  getTrackedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values());
  }

  /** Get a specific tracked model */
  getTrackedModel(catalogId: string): TrackedModel | undefined {
    return this.trackedModels.get(catalogId);
  }

  /** Track a model (when pulling or loading) */
  trackModel(catalogId: string, state: ModelState, backendModelId?: string): TrackedModel {
    const curated = this.getCuratedModel(catalogId);
    const existing = this.trackedModels.get(catalogId);

    const tracked: TrackedModel = {
      catalogId,
      backend: curated?.backend ?? existing?.backend ?? 'ollama',
      backendModelId: backendModelId ?? curated?.backendModelId ?? catalogId,
      state,
      pinned: existing?.pinned ?? false,
      memoryUsedMb: existing?.memoryUsedMb ?? curated?.runtime.memoryFootprintMb ?? 0,
      lastUsedAt: existing?.lastUsedAt,
      requestCount: existing?.requestCount ?? 0,
      pullProgress: state === 'pulling' ? (existing?.pullProgress ?? 0) : undefined,
    };

    this.trackedModels.set(catalogId, tracked);
    return tracked;
  }

  /** Update model state */
  updateModelState(catalogId: string, state: ModelState, errorMessage?: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.state = state;
      if (errorMessage) tracked.errorMessage = errorMessage;
      if (state === 'pinned') tracked.pinned = true;
      if (state === 'loaded' || state === 'pinned') {
        tracked.lastUsedAt = Date.now();
      }
    }
  }

  /** Update pull progress */
  updatePullProgress(catalogId: string, progress: number): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pullProgress = progress;
    }
  }

  /** Pin a model */
  pinModel(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pinned = true;
      tracked.state = 'pinned';
    }
  }

  /** Unpin a model */
  unpinModel(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.pinned = false;
      if (tracked.state === 'pinned') {
        tracked.state = 'loaded';
      }
    }
  }

  /** Record a model usage (for LRU eviction) */
  recordUsage(catalogId: string): void {
    const tracked = this.trackedModels.get(catalogId);
    if (tracked) {
      tracked.lastUsedAt = Date.now();
      tracked.requestCount++;
    }
  }

  /** Get eviction candidates sorted by score (worst first) */
  getEvictionCandidates(): TrackedModel[] {
    return Array.from(this.trackedModels.values())
      .filter((m) => !m.pinned && m.state === 'loaded')
      .sort((a, b) => {
        // Score: lower = evict first
        const aLru = a.lastUsedAt ?? 0;
        const bLru = b.lastUsedAt ?? 0;
        // Oldest last used first
        if (aLru !== bLru) return aLru - bLru;
        // Fewest requests first
        return a.requestCount - b.requestCount;
      });
  }

  /** Remove a tracked model */
  removeTrackedModel(catalogId: string): void {
    this.trackedModels.delete(catalogId);
  }

  /** Get all pinned models */
  getPinnedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values()).filter((m) => m.pinned);
  }

  /** Get loaded models (loaded + pinned) */
  getLoadedModels(): TrackedModel[] {
    return Array.from(this.trackedModels.values()).filter((m) => m.state === 'loaded' || m.state === 'pinned');
  }
}
