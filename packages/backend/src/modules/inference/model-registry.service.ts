import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { CuratedModel, HardwareTier, InferenceBackendType, ModelModality, ModelState, TrackedModel } from '@ci-hub/common/types';
import { CURATED_MODELS } from './catalog/curated-models';

@Injectable()
export class ModelRegistryService implements OnModuleInit {
  /** Tracked model states (in-memory, persisted to disk on changes) */
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

  /** Get default models to pin for a tier */
  getDefaultPinnedModels(tier: HardwareTier): CuratedModel[] {
    return this.getRecommendedModels(tier).filter((m) => m.runtime.pinnedByDefault);
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
