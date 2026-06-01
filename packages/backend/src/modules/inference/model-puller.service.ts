import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import type { HardwareProfile, HardwareTier, InferenceBackendType, PullProgress } from '@ci-hub/common/types';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { MemoryManagerService } from './memory-manager.service';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import type { InferenceBackend } from './backends/backend.interface';
import { isCatalogModelInstalled } from './model-availability.util';
import type { PullEvaluation } from './pull-evaluation.types';

@Injectable()
export class ModelPullerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly memoryManager: MemoryManagerService,
    private readonly hostMetrics: HostMetricsService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
  ) {}

  private getBackend(type: InferenceBackendType): InferenceBackend {
    switch (type) {
      case 'ollama':
        return this.ollamaBackend;
      case 'vllm':
        return this.vllmBackend;
      case 'lemonade':
        return this.lemonadeBackend;
    }
  }

  private async getAvailableDiskMb(): Promise<number> {
    const hostSection = await this.hostMetrics.readHostSection();
    const displayLoad = await this.hostMetrics.getDisplayLoad(0, 0);
    const diskTotalGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskTotalGb : displayLoad.diskSize;
    const diskUsedGb = hostSection && hostSection.diskTotalGb > 0 ? hostSection.diskUsedGb : displayLoad.diskUsed;
    return Math.max(0, (diskTotalGb - diskUsedGb) * 1024);
  }

  private getAvailableMemoryMb(profile: HardwareProfile): number {
    const budget = this.memoryManager.calculateBudget(profile);
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
    const availableMemoryMb = this.getAvailableMemoryMb(profile);
    const requiredDiskMb = curated.requirements?.diskMb ?? 0;
    const requiredMemoryMb = curated.runtime.memoryFootprintMb;

    const ollamaTags =
      curated.backend === 'ollama'
        ? ((await this.ollamaBackend.healthCheck().catch(() => ({ modelsLoaded: [] as string[] }))).modelsLoaded ?? [])
        : [];

    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    const trackedPulled = tracked?.state === 'pulled' || tracked?.state === 'loaded' || tracked?.state === 'pinned';
    const alreadyInstalled = isCatalogModelInstalled(curated, ollamaTags, trackedPulled);

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

    const memoryCheck = this.memoryManager.canFitModel(profile, requiredMemoryMb);
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

  /** Pull a model by catalog ID — enforces preflight checks. */
  async pullModel(catalogId: string, onProgress?: (progress: PullProgress) => void, tier?: HardwareTier): Promise<void> {
    const evaluation = await this.evaluatePull(catalogId, tier);

    if (evaluation.alreadyInstalled) {
      if (!this.modelRegistry.getTrackedModel(catalogId)) {
        this.modelRegistry.trackModel(catalogId, 'pulled');
      } else if (this.modelRegistry.getTrackedModel(catalogId)?.state === 'error') {
        this.modelRegistry.updateModelState(catalogId, 'pulled');
      }
      this.logger.info(`[ModelPuller] ${catalogId} already installed in Ollama — skipping download`);
      return;
    }

    if (!evaluation.canPull) {
      throw new Error(evaluation.reason ?? `Pull blocked for ${catalogId}`);
    }

    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) {
      throw new Error(`Model ${catalogId} not found in catalog`);
    }
    const backend = this.getBackend(curated.backend);

    this.modelRegistry.trackModel(catalogId, 'pulling');
    this.logger.info(`[ModelPuller] Pulling ${catalogId} via ${curated.backend} (backendId: ${curated.backendModelId})`);

    try {
      await backend.pullModel(curated.backendModelId, (progress) => {
        this.modelRegistry.updatePullProgress(catalogId, progress.percent);
        onProgress?.(progress);
      });

      this.modelRegistry.updateModelState(catalogId, 'pulled');
      this.logger.info(`[ModelPuller] Successfully pulled ${catalogId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.modelRegistry.updateModelState(catalogId, 'error', msg);
      this.logger.error(`[ModelPuller] Failed to pull ${catalogId}: ${msg}`);
      throw err;
    }
  }

  /** Load a model into memory */
  async loadModel(catalogId: string): Promise<void> {
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) {
      throw new Error(`Model ${catalogId} not found in catalog`);
    }

    const backend = this.getBackend(curated.backend);

    if (this.modelRegistry.getTrackedModel(catalogId)) {
      this.modelRegistry.updateModelState(catalogId, 'loading');
    } else {
      this.modelRegistry.trackModel(catalogId, 'loading');
    }
    this.logger.info(`[ModelPuller] Loading ${catalogId} into memory`);

    try {
      await backend.loadModel(curated.backendModelId);
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

    const backend = this.getBackend(curated.backend);

    this.modelRegistry.updateModelState(catalogId, 'unloading');
    this.logger.info(`[ModelPuller] Unloading ${catalogId} from memory`);

    try {
      await backend.unloadModel(curated.backendModelId);
      this.modelRegistry.updateModelState(catalogId, 'pulled');
      this.logger.info(`[ModelPuller] Unloaded ${catalogId}`);
    } catch (err) {
      this.logger.error(`[ModelPuller] Failed to unload ${catalogId}: ${err}`);
      throw err;
    }
  }

  /** Pull and load a model, optionally pinning it */
  async pullAndLoad(catalogId: string, pin = false): Promise<void> {
    await this.pullModel(catalogId);
    await this.loadModel(catalogId);
    if (pin) {
      this.modelRegistry.pinModel(catalogId);
    }
  }
}
