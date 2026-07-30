import type { BackendHealthStatus, BackendModelInfo, InferenceBackendType, PullProgress } from '@ci-hub/common/types';

/**
 * Common interface implemented by all inference backends (Ollama, vLLM, Lemonade).
 */
export interface InferenceBackend {
  readonly type: InferenceBackendType;

  /** Base URL for the backend's API (e.g. http://ollama:11434) */
  getBaseUrl(): string;

  /** Check if the backend container is running and healthy */
  healthCheck(): Promise<BackendHealthStatus>;

  /** List models currently available in the backend */
  listModels(): Promise<BackendModelInfo[]>;

  /** Pull/download a model */
  pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void>;

  /** Load a model into memory. Embedding models must be loaded via the
   * embeddings endpoint, so pass `{ embedding: true }` for them. */
  loadModel(modelId: string, options?: { embedding?: boolean }): Promise<void>;

  /** Unload a model from memory. Pass `{ embedding: true }` for embedding
   * models (they reject the text-generation endpoint). */
  unloadModel(modelId: string, options?: { embedding?: boolean }): Promise<void>;

  /** Check if a specific model is loaded */
  isModelLoaded(modelId: string): Promise<boolean>;

  /**
   * Get the Docker image for this backend. Some implementations accept additional GPU-runtime
   * hints beyond the base signature — e.g. OllamaBackend's `{ rocmReady, unifiedMemory }` selects
   * between its ROCm and Vulkan-fallback tags for AMD GPUs — see the implementing class.
   */
  getDockerImage(options?: { rocmReady?: boolean; unifiedMemory?: boolean }): string;

  /**
   * Get Docker compose service configuration for deploying this backend. `options` carries the
   * same optional GPU-runtime hints as getDockerImage(); backends that don't need them ignore the
   * parameter. Backends without a viable image for a given `gpuVendor` (e.g. VllmBackend for
   * `'amd'` — see that class for why) throw rather than returning a broken config.
   */
  getComposeConfig(gpuVendor: string, options?: { rocmReady?: boolean; unifiedMemory?: boolean }): Record<string, unknown>;
}
