import type { BackendHealthStatus, BackendModelInfo, BackendResidency, InferenceBackendType, PullProgress } from '@ci-hub/common/types';

/**
 * Common interface implemented by all inference backends (Ollama, vLLM, Lemonade, MTPLX,
 * mlx-dspark, and Lucebox speculative inference).
 */
export interface InferenceBackend {
  readonly type: InferenceBackendType;

  /** Base URL for the backend's API (e.g. http://ollama:11434) */
  getBaseUrl(): string;

  /** API key for direct app access when the backend authenticates requests. */
  getApiKey?(): string | undefined;

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
   * What is IN MEMORY right now, and how the backend knows.
   *
   * Optional, and the optionality is the point. An engine that cannot answer must be able to
   * say so: the caller reports `source: 'unsupported'` with `models: null`, which is a
   * different fact from an engine that answered "nothing is loaded" (`'measured'`, `[]`).
   * Making this required would force every implementation to invent one of those two answers.
   *
   * Implementations must NOT satisfy this from `healthCheck().modelsLoaded` — that field is the
   * on-disk inventory despite its name, and forwarding it here would rebuild the exact
   * confusion this method exists to end. Either query the engine for real residency, or return
   * `'implicit'` when the engine can only ever serve what it was started with.
   */
  listResident?(): Promise<BackendResidency>;

  /**
   * Tell the backend that a request it accepted for `modelId` failed in a way that suggests it
   * cannot serve that model — pass only server-side rejections, never connection errors (those are
   * the whole backend being down, which `healthCheck` already reports).
   *
   * Optional because it is a *feedback* channel, not a capability: a backend that implements it
   * feeds the observation back into `healthCheck().unservableModels` so routing stops choosing it,
   * and one that does not simply keeps offering the model. The alternative — proving serveability
   * from the health check itself — means generating on every poll, which would load every listed
   * model into VRAM on the poll cadence.
   */
  noteServingFailure?(modelId: string, reason: string): void;

  /** The counterpart: `modelId` was served, so clear whatever {@link noteServingFailure} accumulated. */
  noteServingSuccess?(modelId: string): void;

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
