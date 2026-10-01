import type { BackendHealthStatus, BackendModelInfo, BackendResidency, InferenceBackendType, PullProgress } from '@ci-hub/common/types';
import type { ContextCost } from '../model-geometry.util';

export interface LoadModelOptions {
  embedding?: boolean;
  /** The context window, in tokens, to load a text model with. Absent leaves it to the engine. */
  contextLength?: number;
  /**
   * `contextLength` is for this residency only: the Hub stepped it below an installed app's floor
   * because what held the card could not be unloaded for this load. An engine that saves a model's
   * window for its own later loads (Lemonade's `save_options`) keeps a larger saved window rather than
   * lower it to this one. Ignored by engines that take a window per load only.
   */
  provisionalWindow?: boolean;
  /**
   * Load on the CPU rather than the GPU. Set for an embedder on an AMD ROCm host (see
   * `embedderRunsOnCpu`); only Lemonade honours it, as the one engine the Hub tells where to run a
   * model. Absent leaves the engine's own choice.
   */
  device?: 'cpu';
}

/**
 * What an engine says about its own concurrency, when it says anything: how many requests it runs
 * at once and the context window each of them gets. The same two numbers a node's operator states
 * for Ollama as `inferenceOllamaSlots` / `inferenceMaxNumCtx` (`OLLAMA_NUM_PARALLEL` and
 * `OLLAMA_CONTEXT_LENGTH` are not readable from Ollama's API); an engine that exposes them reads
 * them instead. `null` on a field the engine did not report.
 */
export interface EngineCapabilities {
  slots: number | null;
  contextLength: number | null;
}

/**
 * Common interface implemented by all inference backends (Ollama, vLLM, Lemonade, MTPLX,
 * mlx-dspark, Lucebox speculative inference, llama.cpp, LM Studio).
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
   * embeddings endpoint, so pass `{ embedding: true }` for them. `contextLength` is the window to
   * load it with, for an engine that takes one at load time; one that cannot ignores it. */
  loadModel(modelId: string, options?: LoadModelOptions): Promise<void>;

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
   * What a token of context costs this model, from the engine's own description of it. Optional:
   * only Ollama can say (`/api/show` geometry, `/api/ps` sightings); without it the context ladder
   * keeps its fixed per-token assumption.
   */
  contextCostForModel?(modelId: string): Promise<ContextCost | null>;

  /**
   * MB the model's files take on disk — weights plus any vision projector — for an engine that
   * lists them but cannot say what a token of context costs. Optional; null when it cannot say.
   */
  weightsOnDiskMb?(modelId: string): Promise<number | null>;

  /**
   * Whether the engine's server can supply a catalog `backendModelId` — has it, or can download it —
   * from the registry listing its last health probe read. Optional: only an engine whose server lists
   * its whole registry implements it (Lemonade's `GET /v1/models?show_all=true`). `null` when it
   * cannot say, which callers treat as offered: the behaviour before this existed.
   */
  offersModel?(modelId: string): boolean | null;

  /**
   * The name the engine's server knows a catalog `backendModelId` by, when that can differ from the
   * catalog's spelling (Lemonade 10.x files Hub-registered models as `user.<id>`). Optional; without
   * it the catalog id is the engine's id.
   */
  engineModelId?(modelId: string): string;

  /**
   * The engine's own statement of slots and per-slot context, from the LAST health probe — never a
   * request of its own, because the pool proxy reads it while ranking every request. Optional:
   * only an engine that exposes the figures implements it (llama-server's `/props`, Lemonade's
   * saved `ctx_size` for the model it holds); for the rest the operator's statement in the inference
   * preferences is the only source. `null` when the last probe did not reach the engine.
   */
  engineCapabilities?(): EngineCapabilities | null;

  /**
   * The window this engine serves `modelId` at whatever a request asks, for an engine that takes no
   * window per request: Lemonade's saved `ctx_size`. A handout for such a model is never above it,
   * since the engine would not serve more. Optional: Ollama loads at the window each request names,
   * and an engine that cannot say leaves the handout as sized. Null when nothing is saved.
   */
  servedContextLength?(modelId: string): Promise<number | null>;

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
   *
   * Returns true when this observation is the one that withheld the model — that is, when the
   * next `healthCheck()` will report it in `unservableModels` and the last one did not — so a
   * caller holding a cached health answer knows it is now wrong. The pool proxy ranks from such a
   * cache.
   */
  noteServingFailure?(modelId: string, reason: string): boolean;

  /**
   * The counterpart: `modelId` was served, so clear whatever {@link noteServingFailure}
   * accumulated. Returns true when the model was withheld until now, for the same caller.
   */
  noteServingSuccess?(modelId: string): boolean;

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
