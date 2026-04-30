import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackendType, PullProgress } from '@ci-hub/common/types';
import { ModelRegistryService } from './model-registry.service';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import type { InferenceBackend } from './backends/backend.interface';

@Injectable()
export class ModelPullerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
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

  /** Pull a model by catalog ID */
  async pullModel(catalogId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
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

    this.modelRegistry.updateModelState(catalogId, 'loading');
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
