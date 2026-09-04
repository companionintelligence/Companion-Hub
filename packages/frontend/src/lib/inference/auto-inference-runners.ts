import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

export type AutomaticInferenceRunner = 'dspark' | 'mtplx' | 'lucebox' | 'vllm' | 'ollama';

export type AutomaticInferenceRunnerState = 'already_running' | 'installed_and_started' | 'installed' | 'skipped' | 'failed';

export interface AutomaticInferenceRunnerResult {
  runner: AutomaticInferenceRunner | string;
  state: AutomaticInferenceRunnerState;
  endpointUrl?: string;
  detail?: string;
}

export const DEFAULT_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['dspark', 'mtplx', 'lucebox', 'vllm', 'ollama'];

/**
 * The first-run set for Apple Silicon Macs. mlx-dspark handles chat while
 * Ollama supplies embeddings, so both services need to be present before the
 * default FTUE can finish with a useful local setup.
 */
export const DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['dspark', 'ollama'];

/**
 * Keep the native FTUE install set aligned with the selected Apple Silicon
 * backend. MTPLX is an alternative to mlx-dspark, not a second server to
 * launch alongside it; Ollama remains the shared embeddings service.
 */
export const DEFAULT_MACOS_MTPLX_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['mtplx', 'ollama'];

const AUTOMATIC_RUNNERS_BY_BACKEND: Record<string, AutomaticInferenceRunner[]> = {
  dspark: DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS,
  mtplx: DEFAULT_MACOS_MTPLX_AUTOMATIC_INFERENCE_RUNNERS,
  lucebox: ['lucebox', 'ollama'],
  vllm: ['vllm', 'ollama'],
  // Lemonade is an operator-managed host service. Ollama is still installed for
  // the embeddings path shared by every chat backend.
  lemonade: ['ollama'],
  ollama: ['ollama'],
};

export function automaticRunnersForBackend(backend: string): AutomaticInferenceRunner[] {
  return AUTOMATIC_RUNNERS_BY_BACKEND[backend] ?? DEFAULT_AUTOMATIC_INFERENCE_RUNNERS;
}

/**
 * Ask the desktop shell to install and launch host/container inference
 * runners. A browser build has no safe native process boundary, so it is a
 * no-op there and keeps the existing manual setup flow.
 */
export async function installAndStartInferenceRunners(
  runners: AutomaticInferenceRunner[] = DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
): Promise<AutomaticInferenceRunnerResult[]> {
  const invoke = getTauriInvoke();
  if (!invoke) return [];
  const result = await invoke('install_and_start_inference_runners_command', { backends: runners });
  return Array.isArray(result) ? (result as AutomaticInferenceRunnerResult[]) : [];
}
