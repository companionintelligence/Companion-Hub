import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import type { CuratedModel, HardwareProfile, HardwareTier, PullProgress } from '@ci-hub/common/types';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { isCatalogModelInstalled, isServedModelForCatalog } from './model-availability.util';
import type { PullEvaluation, PullStartResult } from './pull-evaluation.types';
import { InferenceBackendRegistry } from './backends/backend-registry';

/**
 * No quantization the catalog carries stores a weight in fewer bits: q4_0 and the q4_K family keep
 * about 4.5, mxfp4 4.25, q4_1 5, and everything else more.
 */
const MIN_BITS_PER_WEIGHT = 4;

/**
 * The least memory a model's weights can take once an engine has loaded them, in MB: 4 bits per
 * parameter, and never more than the download.
 *
 * The download gate needs a lower bound, not the catalog footprint. That footprint is the download
 * plus 10 %, and a download can hold far more than the engine puts on the card. gemma4:e4b downloads
 * 9,163 MiB, but most of that is per-layer embedding tables that stay in system RAM. On beta-red's
 * RTX 3080, Ollama holds it at 3,209 MiB (`/api/ps` size equal to size_vram), and nvidia-smi shows
 * 5,550 MiB for the whole runner at 16384 tokens. The catalog footprint is 10,813 MB, which refused the
 * fleet's default app model on every 8 and 10 GB card. The row's `params` is the effective 4B, not the
 * 8B Ollama reports, so this floor (1,907 MB) stays below what the card really holds.
 *
 * With no parameter count (speech and embedding rows), the download itself is the only size known.
 */
export function weightsFloorMb(model: Pick<CuratedModel, 'parameterScale' | 'requirements'>): number {
  const diskMb = Math.max(0, model.requirements?.diskMb ?? 0);
  const params = model.parameterScale;
  if (typeof params !== 'number' || !Number.isFinite(params) || params <= 0) return diskMb;
  const floorMb = Math.floor((params * 1e9 * MIN_BITS_PER_WEIGHT) / 8 / 1_048_576);
  return diskMb > 0 ? Math.min(diskMb, floorMb) : floorMb;
}

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

  /**
   * The node's model memory twice over: `availableMb` is what is free right now (reported, never
   * gated on — see evaluatePull), `capacityMb` is the whole budget with nothing loaded, which a model's
   * weights must fit to be loadable here at all. `onGpu` says the budget is a discrete card's.
   */
  private async getModelMemoryMb(profile: HardwareProfile): Promise<{ availableMb: number; capacityMb: number; onGpu: boolean }> {
    const budget = await this.memoryManager.calculateBudget(profile);
    if (profile.gpu.available && !profile.gpu.unifiedMemory) {
      return {
        availableMb: Math.max(0, budget.modelBudgetVramMb - budget.modelUsedVramMb),
        capacityMb: budget.modelBudgetVramMb,
        onGpu: true,
      };
    }
    return { availableMb: Math.max(0, budget.modelBudgetRamMb - budget.modelUsedRamMb), capacityMb: budget.modelBudgetRamMb, onGpu: false };
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
    const { availableMb: availableMemoryMb, capacityMb: memoryCapacityMb, onGpu } = await this.getModelMemoryMb(profile);
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

    // Before the tier check, which would otherwise misreport this as a hardware limit: the registry
    // drops such a row from every tier (ModelRegistryService.engineOffers).
    if (backend.offersModel?.(curated.backendModelId) === false) {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason:
          `${curated.backend} on this node does not list ${curated.backendModelId} in its model registry, so it cannot download it. ` +
          `Upgrade ${curated.backend}, or choose a model it lists.`,
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

    if (curated.backend === 'omlx' || curated.backend === 'vllm') {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason: 'This engine loads weights on the host. Download them there, then re-check.',
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

    // No free-memory check here: a download writes to disk, not to VRAM. Whether the model fits
    // right now depends on what else is resident, which is the load path's question — the router
    // checks `canFitModel` there and evicts to make room. Gating the download on it refused any
    // large model while another engine held the GPU.
    //
    // The whole budget is a different matter. The tier check above is coarse — an RTX 3080 (10 GB)
    // reads as tier `medium`, which admits 20+ GB models — and a model whose weights alone are bigger
    // than everything this node can give a model with nothing else loaded is refused by every load
    // and pin, so downloading it only spends the disk.
    //
    // The gate compares a lower bound on the weights (weightsFloorMb), never the catalog footprint.
    // The footprint is an estimate that is too high for some models, and nothing has been measured
    // on this node before the download. A download that only the footprint objects to goes ahead
    // with a warning, because the load path judges it again, against measurements once it has any.
    //
    // On a discrete card this is the GPU budget, not GPU plus system RAM. An engine can run a larger
    // model partly from system RAM, but the Hub's load and pin only place a model wholly on the card.
    const capacityMb = Math.floor(memoryCapacityMb);
    const memoryKind = onGpu ? 'GPU memory ' : '';
    const weightsMb = weightsFloorMb(curated);
    if (weightsMb > memoryCapacityMb) {
      return {
        catalogId,
        alreadyInstalled: false,
        canPull: false,
        reason:
          `Model's weights need at least ${weightsMb} MB, more than the ${capacityMb} MB of ${memoryKind}this node has for models ` +
          `with nothing else loaded, so it could never be loaded ${onGpu ? 'onto the GPU ' : ''}here.`,
        requiredDiskMb,
        requiredMemoryMb,
        availableDiskMb,
        availableMemoryMb,
      };
    }

    const warning =
      requiredMemoryMb > memoryCapacityMb
        ? `The catalog estimates ${requiredMemoryMb} MB for this model once loaded, more than the ${capacityMb} MB of ${memoryKind}this node has ` +
          `for models, so a pin or load may be refused. It downloads anyway: its weights need at least ${weightsMb} MB, and the estimate ` +
          'is too high for some models.'
        : undefined;

    return {
      catalogId,
      alreadyInstalled: false,
      canPull: true,
      ...(warning ? { warning } : {}),
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
    let evaluation: PullEvaluation;
    try {
      evaluation = await this.evaluatePull(catalogId, options?.tier);
    } catch (err) {
      // A refusal the caller can show, not an HTTP 500: the exception filter replaces a plain Error's
      // message with INTERNAL_SERVER_ERROR, so the UI could only say that a download failed.
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ModelPuller] Pull of ${catalogId} not started: ${reason}`);
      return { catalogId, status: 'error', reason };
    }

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

    if (evaluation.warning) {
      this.logger.warn(`[ModelPuller] ${catalogId}: ${evaluation.warning}`);
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

  /**
   * Load a model into memory, at `contextLength` when the caller sized one. Callers outside the
   * inference router should go through `InferenceRouterService.loadTrackedModel`, which makes room
   * and sizes the window first; this only talks to the engine.
   */
  async loadModel(catalogId: string, options?: { contextLength?: number }): Promise<void> {
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
      // The engine's spelling: Lemonade 10.x knows a Hub-registered model only as `user.<id>`.
      const engineId = backend.engineModelId?.(curated.backendModelId) ?? curated.backendModelId;
      await backend.loadModel(engineId, { embedding: curated.modality === 'embedding', contextLength: options?.contextLength });
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
      const engineId = backend.engineModelId?.(curated.backendModelId) ?? curated.backendModelId;
      await backend.unloadModel(engineId, { embedding: curated.modality === 'embedding' });
      this.modelRegistry.updateModelState(catalogId, 'pulled');
      this.logger.info(`[ModelPuller] Unloaded ${catalogId}`);
    } catch (err) {
      this.logger.error(`[ModelPuller] Failed to unload ${catalogId}: ${err}`);
      throw err;
    }
  }
}
