/**
 * Whatever brings running AI apps' inference config up to date after a change that moves it.
 *
 * `AiAppInferenceRefreshService` is the only implementation and lives in `AppLifecycleModule`, which
 * imports `InferenceModule`, which imports `HubPoolModule`. The pool controller therefore resolves
 * this token through `ModuleRef` with `strict: false`, the lazy-lookup shape `POOL_CONTAINER_SAMPLER`
 * already uses, instead of importing its way back up that chain.
 *
 * The token and the interface live in a leaf helper with no imports, so neither side imports the
 * other's module to name them.
 */
export const INFERENCE_ENV_REFRESHER = 'INFERENCE_ENV_REFRESHER';

export interface InferenceEnvRefresher {
  /** Ask for a debounced sweep that restarts the AI apps whose inference env is stale. Returns immediately. */
  requestRefresh(reason: string): void;
}
