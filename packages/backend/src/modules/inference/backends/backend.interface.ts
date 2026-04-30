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

  /** Load a model into memory */
  loadModel(modelId: string): Promise<void>;

  /** Unload a model from memory */
  unloadModel(modelId: string): Promise<void>;

  /** Check if a specific model is loaded */
  isModelLoaded(modelId: string): Promise<boolean>;

  /** Get the Docker image for this backend */
  getDockerImage(): string;

  /** Get Docker compose service configuration for deploying this backend */
  getComposeConfig(gpuVendor: string): Record<string, unknown>;
}
