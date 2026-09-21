import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import type { HardwareProfile, HardwareTier, PullProgress } from '@ci-hub/common/types';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { isCatalogModelInstalled, isServedModelForCatalog } from './model-availability.util';
import type { PullEvaluation, PullStartResult } from './pull-evaluation.types';
import { InferenceBackendRegistry } from './backends/backend-registry';

@Injectable()
export class ModelPullerService {
  private readonly pullQueue: string[] = [];
  private readonly pullActiveIds = new Set<string>();
  private pullWorkerPromise: Promise<void> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly memoryManager: MemoryManagerService,
    private readonly hostMetrics: HostMetricsService,
    private readonly backends: InferenceBackendRegistry,
  ) {}

  private async getAvailableDiskMb(): Promise<number> {
    const hostSection = await this.hostMetrics.readHostSection();
    const displayLoad = await this.hostMetrics.getDisplayLoad(0, 0);
    const diskTotalGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskTotalGb : displayLoad.diskSize;
    const diskUsedGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskUsedGb : displayLoad.diskUsed;
    return Math.max(0, (diskTotalGb - diskUsedGb) * 1024);
  }

  private async getAvailableMemoryMb(profile: HardwareProfile): Promise<number> {
    const budget = await this.memoryManager.calculateBudget(profile);
    if (profile.gpu.available && !profile.gpu.unifiedMemory) {
      return Math.max(0, budget.modelBudgetVramMb - budget.modelUsedVramMb);
    }
    return Math.max(0, budget.modelBudgetRamMb - budget.modelUsedRamMb);
  }

  /** Evaluate whether a catalog model can be pulled given hardware, disk, and Ollama state. */
  async evaluatePull(catalogId: string, tier?: HardwareTier): Promise<PullEvaluation> {
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) {
      throw new Error(`Model ${catalogId} not found in catalog`);
    }

    const profile = await this.hardwareInspector.getProfile();
    const effectiveTier = tier ?? profile.tier;
    const tierModels = this.modelRegistry.getModelsForTier(effectiveTier);
    const availableDiskMb = await this.getAvailableDiskMb();
    const availableMemoryMb = await this.getAvailableMemoryMb(profile);
    const requiredDiskMb = curated.requirements?.diskMb ?? 0;
    const requiredMemoryMb = curated.runtime.memoryFootprintMb;

    const backend = this.backends.get(curated.backend);
    const backendModels = (await backend.healthCheck().catch(() => ({ modelsLoaded: [] as string[] }))).modelsLoaded ?? [];

    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    const trackedPulled = tracked?.state === 'pulled' || tracked?.state === 'loaded' || tracked?.state === 'pinned';
    const alreadyInstalled =
      trackedPulled ||
      (curated.backend === 'ollama'
        ? isCatalogModelInstalled(curated, backendModels, false, this.modelRegistry.getCatalogBackendModelIds())
        : isServedModelForCatalog(curated, backendModels));

    if (alreadyInstalled) {
      return {
        catalogId,
        alreadyInstalled: true,
        canPull: true,
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    if (!tierModels.some((m) => m.id === catalogId)) {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason: `Model ${catalogId} is not available for your hardware tier (${effectiveTier}).`,
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    if (curated.backend === 'lucebox') {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason: 'Speculative inference models are loaded when the server starts; start it with this model, then re-check.',
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    if (requiredDiskMb > availableDiskMb) {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason: `Model requires ${requiredDiskMb} MB disk but only ${Math.floor(availableDiskMb)} MB is available.`,
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    const memoryCheck = await this.memoryManager.canFitModel(profile, requiredMemoryMb);
    if (!memoryCheck.fits) {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason: `Model requires ${requiredMemoryMb} MB inference memory but only ${Math.floor(memoryCheck.availableMb)} MB is available.`,
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    return {
      catalogId,
      alreadyInstalled: false,
      canPull: true,
      requiredDiskMb,
      requiredMemoryMb,
      availableDiskMb,
      availableMemoryMb,
    };
  }

  private markAlreadyInstalled(catalogId: string): void {
    if (!this.modelRegistry.getTrackedModel(catalogId)) {
      this.modelRegistry.trackModel(catalogId, 'pulled');
    } else if (this.modelRegistry.getTrackedModel(catalogId)?.state === 'error') {
      this.modelRegistry.updateModelState(catalogId, 'pulled');
    }
  }

  /** Enqueue a model pull and return immediately. One Ollama pull runs at a time. */
  async startPull(catalogId: string, options?: { bestEffort?: boolean; tier?: HardwareTier }): Promise<PullStartResult> {
    const evaluation = await this.evaluatePull(catalogId, options?.tier);

    if (evaluation.alreadyInstalled) {
      this.markAlreadyInstalled(catalogId);
      return { catalogId, status: 'already_installed' };
    }

    if (!evaluation.canPull) {
      const reason = evaluation.reason ?? `Pull blocked for ${catalogId}`;
      if (options?.bestEffort) {
        this.logger.warn(`[ModelPuller] Pull skipped ${catalogId}: ${reason}`);
        return { catalogId, status: 'skipped', reason };
      }
      return { catalogId, status: 'error', reason };
    }

    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    if (tracked?.state === 'pulling' || this.pullActiveIds.has(catalogId)) {
      return { catalogId, status: 'in_progress' };
    }

    this.pullActiveIds.add(catalogId);
    this.pullQueue.push(catalogId);
    void this.drainPullQueue();
    return { catalogId, status: 'queued' };
  }

  private drainPullQueue(): Promise<void> {
    if (this.pullWorkerPromise) {
      return this.pullWorkerPromise;
    }

    this.pullWorkerPromise = (async () => {
      while (this.pullQueue.length > 0) {
        const nextId = this.pullQueue.shift();
        if (!nextId) continue;
        try {
          await this.pullModel(nextId);
        } catch {
          // pullModel logs and updates tracked state on failure
        }
      }
    })().finally(() => {
      this.pullWorkerPromise = null;
      if (this.pullQueue.length > 0) {
        void this.drainPullQueue();
      }
    });

    return this.pullWorkerPromise;
  }

  /** Wait until a queued or in-flight pull reaches a terminal tracked state. */
  async waitForPullCompletion(catalogId: string, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const tracked = this.modelRegistry.getTrackedModel(catalogId);
      if (tracked?.state === 'pulled' || tracked?.state === 'loaded' || tracked?.state === 'pinned') {
        return;
      }
      if (tracked?.state === 'error') {
        throw new Error(tracked.errorMessage ?? `Pull failed for ${catalogId}`);
      }

      const pending = this.pullActiveIds.has(catalogId) || this.pullQueue.includes(catalogId);
      if (!pending && !tracked) {
        const evaluation = await this.evaluatePull(catalogId);
        if (evaluation.alreadyInstalled) {
          this.markAlreadyInstalled(catalogId);
          return;
        }
        throw new Error(`Pull not started for ${catalogId}`);
      }

      if (this.pullWorkerPromise) {
        await Promise.race([this.pullWorkerPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw new Error(`Pull timed out for ${catalogId}`);
  }

  /** Enqueue a pull and block until it completes (uses the serial queue). */
  async pullAndWait(catalogId: string, options?: { bestEffort?: boolean; tier?: HardwareTier }): Promise<void> {
    const result = await this.startPull(catalogId, options);
    if (result.status === 'already_installed') {
      return;
    }
    if (result.status === 'skipped') {
      if (options?.bestEffort) {
        return;
      }
      throw new Error(result.reason ?? `Pull skipped for ${catalogId}`);
    }
    if (result.status === 'error') {
      throw new Error(result.reason ?? `Pull blocked for ${catalogId}`);
    }
    await this.waitForPullCompletion(catalogId);
  }

  /** Pull a model by catalog ID — queue worker only; use startPull or pullAndWait externally. */
  async pullModel(catalogId: string, onProgress?: (progress: PullProgress) => void, tier?: HardwareTier): Promise<void> {
    try {
      const curated = this.modelRegistry.getCuratedModel(catalogId);
      if (!curated) {
        throw new Error(`Model ${catalogId} not found in catalog`);
      }
      const evaluation = await this.evaluatePull(catalogId, tier);

      if (evaluation.alreadyInstalled) {
        this.markAlreadyInstalled(catalogId);
        this.logger.info(`[ModelPuller] ${catalogId} already installed in ${curated.backend} — skipping download`);
        return;
      }

      if (!evaluation.canPull) {
        throw new Error(evaluation.reason ?? `Pull blocked for ${catalogId}`);
      }

      const backend = this.backends.get(curated.backend);
      let lastLoggedPercent = -1;
      let lastLoggedStatus = '';

      this.modelRegistry.trackModel(catalogId, 'pulling');
      this.logger.info(`[ModelPuller] Pulling ${catalogId} via ${curated.backend} (backendId: ${curated.backendModelId})`);

      await backend.pullModel(curated.backendModelId, (progress) => {
        this.modelRegistry.updatePullProgress(catalogId, progress.percent);
        const rawPercent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null;
        const status = progress.status?.trim() || 'pulling';
        const shouldLogProgress = status !== lastLoggedStatus || (rawPercent !== null && rawPercent > lastLoggedPercent) || rawPercent === 100;

        if (shouldLogProgress) {
          const progressLabel = rawPercent === null ? status : `${rawPercent}% ${status}`;
          this.logger.info(`[ModelPuller] Pull progress ${catalogId}: ${progressLabel}`);
          lastLoggedStatus = status;
          if (rawPercent !== null) {
            lastLoggedPercent = rawPercent;
          }
        }

        onProgress?.(progress);
      });

      this.modelRegistry.updateModelState(catalogId, 'pulled');
      this.logger.info(`[ModelPuller] Successfully pulled ${catalogId}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Pull blocked')) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (this.modelRegistry.getTrackedModel(catalogId)) {
        this.modelRegistry.updateModelState(catalogId, 'error', msg);
      }
      this.logger.error(`[ModelPuller] Failed to pull ${catalogId}: ${msg}`);
      throw err;
    } finally {
      this.pullActiveIds.delete(catalogId);
    }
  }

  /** Load a model into memory */
  async loadModel(catalogId: string): Promise<void> {
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) {
      throw new Error(`Model ${catalogId} not found in catalog`);
    }

    const backend = this.backends.get(curated.backend);

    if (this.modelRegistry.getTrackedModel(catalogId)) {
      this.modelRegistry.updateModelState(catalogId, 'loading');
    } else {
      this.modelRegistry.trackModel(catalogId, 'loading');
    }
    this.logger.info(`[ModelPuller] Loading ${catalogId} into memory`);

    try {
      await backend.loadModel(curated.backendModelId, { embedding: curated.modality === 'embedding' });
      this.modelRegistry.updateModelState(catalogId, 'loaded');
      this.logger.info(`[ModelPuller] Loaded ${catalogId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.modelRegistry.updateModelState(catalogId, 'error', msg);
      throw err;
    }
  }

  /** Unload a model from memory */
  async unloadModel(catalogId: string): Promise<void> {
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) {
      throw new Error(`Model ${catalogId} not found in catalog`);
    }

    const backend = this.backends.get(curated.backend);

    this.modelRegistry.updateModelState(catalogId, 'unloading');
    this.logger.info(`[ModelPuller] Unloading ${catalogId} from memory`);

    try {
      await backend.unloadModel(curated.backendModelId, { embedding: curated.modality === 'embedding' });
      this.modelRegistry.updateModelState(catalogId, 'pulled');
      this.logger.info(`[ModelPuller] Unloaded ${catalogId}`);
    } catch (err) {
      this.logger.error(`[ModelPuller] Failed to unload ${catalogId}: ${err}`);
      throw err;
    }
  }

  /** Pull and load a model, optionally pinning it */
  async pullAndLoad(catalogId: string, pin = false): Promise<void> {
    await this.pullAndWait(catalogId);
    await this.loadModel(catalogId);
    if (pin) {
      this.modelRegistry.pinModel(catalogId);
    }
  }
}
