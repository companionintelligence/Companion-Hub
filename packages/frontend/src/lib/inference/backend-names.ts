import type { InferenceBackendType } from '@ci-hub/common/types';

/**
 * How each engine is named in copy. One table, so the backend picker, the resource summary and
 * any note that says "already in <engine>" agree — the summary used to say "already in Ollama"
 * whatever engine was selected.
 */
export const BACKEND_DISPLAY_NAMES: Record<InferenceBackendType, string> = {
  ollama: 'Ollama',
  vllm: 'vLLM',
  lemonade: 'Lemonade',
  omlx: 'oMLX',
};

export function backendDisplayName(backend: InferenceBackendType): string {
  return BACKEND_DISPLAY_NAMES[backend] ?? backend;
}
