import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, InferenceBackendType, InferenceModelInfo, InferenceStatus } from '@ci-hub/common/types';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { MemoryManagerService } from './memory-manager.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { InferenceBackend } from './backends/backend.interface';
import { resolveInstalledCatalogIds } from './model-availability.util';

/** One parallel health sweep over every registered backend. */
type ProbedBackends = ReadonlyArray<readonly [InferenceBackendType, InferenceBackend, BackendHealthStatus]>;

/**
 * Inference router — read-only view over the local backends + cloud key store.
 *
 * The Hub no longer proxies inference requests (apps call Ollama or a cloud
 * provider directly), so this service no longer forwards chat/embeddings/audio
 * requests. It still surfaces backend health + the merged model list used by the
 * management endpoints (`status`, `models/runtime`) and the credentials service.
 */
@Injectable()
export class InferenceRouterService {
  constructor(
    readonly _logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly memoryManager: MemoryManagerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly backends: InferenceBackendRegistry,
  ) {}

  /**
   * Health-check every backend once, concurrently.
   *
   * Concurrency is the point. A backend whose URL does not resolve does not fail fast — Node's
   * `getaddrinfo` blocks for the resolver timeout — so probing six of them in sequence costs the
   * sum of their stalls rather than the worst one.
   */
  private async probeBackends(): Promise<ProbedBackends> {
    return Promise.all(this.backends.entries().map(async ([type, backend]) => [type, backend, await backend.healthCheck()] as const));
  }

  /** Get full inference status for MCP / API */
  async getStatus(): Promise<InferenceStatus> {
    const profile = await this.hardwareInspector.getProfile();
    const budget = this.memoryManager.calculateBudget(profile);

    const probed = await this.probeBackends();
    const backends = probed.map(([type, backend, health]) => {
      const unservableModels = this.inBothIdSpaces(health.unservableModels ?? []);
      return {
        type,
        running: health.running,
        healthy: health.healthy,
        url: backend.getBaseUrl(),
        modelsLoaded: health.modelsLoaded.length,
        ...(unservableModels.length > 0 ? { unservableModels } : {}),
      };
    });

    // Build merged model list. Hand it the probe we just did: `listModels` otherwise repeats the
    // whole fan-out, and on a node with one slow backend that doubling is what blows the caller's
    // budget rather than the backend itself.
    const models = await this.listModels(probed);

    const cloudProviders = this.cloudFallback.listProviders().map((p) => ({
      provider: p.provider,
      enabled: p.enabled,
      configured: !!p.apiKey,
    }));

    return {
      hardwareTier: profile.tier,
      backends,
      models,
      memoryBudget: budget,
      cloudProviders,
    };
  }

  /**
   * Engine-native model ids plus the catalog ids they map onto, de-duplicated.
   *
   * A backend reports withheld models in its own id space (`gemma3:1b`), while everything built on
   * the catalog — the pool's advertised inventory above all — speaks catalog ids (`gemma3-1b`).
   * Neither consumer carries a lookup table, and the mapping lives here, next to the registry that
   * owns it, so the status carries both and either side can filter with a plain `includes`.
   */
  private inBothIdSpaces(backendModelIds: string[]): string[] {
    if (backendModelIds.length === 0) {
      return [];
    }
    // Exact-id backends (vLLM and friends) fall through the same helper unharmed: its first test is
    // equality, and only the Ollama tag suffixes below that are Ollama-shaped.
    return [...new Set([...backendModelIds, ...resolveInstalledCatalogIds(this.modelRegistry.getCatalog(), backendModelIds)])];
  }

  /**
   * List all available models (local + cloud).
   *
   * `probed` lets a caller that has already health-checked every backend hand the result in.
   * Without it this probes them itself — in parallel, never in sequence.
   */
  async listModels(probed?: ProbedBackends): Promise<InferenceModelInfo[]> {
    const models: InferenceModelInfo[] = [];
    const now = Math.floor(Date.now() / 1000);

    // Local models from tracked state
    for (const tracked of this.modelRegistry.getTrackedModels()) {
      const curated = this.modelRegistry.getCuratedModel(tracked.catalogId);
      models.push({
        id: tracked.catalogId,
        object: 'model',
        created: now,
        owned_by: `local:${tracked.backend}`,
        state: tracked.state,
        backend: tracked.backend,
        modality: curated ? [curated.modality === 'llm' ? 'text' : curated.modality] : ['text'],
        local: true,
        context_window: curated?.runtime.contextWindow,
        max_tokens: curated?.runtime.maxTokens,
      });
    }

    // Also include curated models not yet tracked (available state). Ollama cloud-proxied tags (e.g.
    // `deepseek-v4-pro:cloud`) are skipped — they don't download or run on this machine, so listing one
    // as `local: true` below would be a lie. The catalog is meant to carry none of these; this is a
    // backstop, matching the same guard in ModelRegistryService#getModelsForTier.
    for (const curated of this.modelRegistry.getCatalog()) {
      if (curated.backend === 'ollama' && curated.backendModelId?.endsWith(':cloud')) continue;
      if (!this.modelRegistry.getTrackedModel(curated.id)) {
        models.push({
          id: curated.id,
          object: 'model',
          created: now,
          owned_by: `catalog:${curated.backend}`,
          state: 'available',
          backend: curated.backend,
          modality: [curated.modality === 'llm' ? 'text' : curated.modality],
          local: true,
          context_window: curated.runtime.contextWindow,
          max_tokens: curated.runtime.maxTokens,
        });
      }
    }

    // Cloud models
    for (const provider of this.cloudFallback.getEnabledProviders()) {
      models.push({
        id: provider.defaultModel,
        object: 'model',
        created: now,
        owned_by: `cloud:${provider.provider}`,
        state: 'available',
        backend: 'cloud',
        modality: ['text'],
        local: false,
      });
    }

    // Discovered models from backends (not in curated catalog or tracked)
    const knownIds = new Set(models.map((m) => m.id));
    for (const [backendType, , health] of probed ?? (await this.probeBackends())) {
      if (health.running && health.healthy) {
        for (const modelName of health.modelsLoaded) {
          if (!knownIds.has(modelName)) {
            models.push({
              id: modelName,
              object: 'model',
              created: now,
              owned_by: `local:${backendType}`,
              state: 'loaded',
              backend: backendType,
              modality: ['text'],
              local: true,
            });
            knownIds.add(modelName);
          }
        }
      }
    }

    return models;
  }
}
