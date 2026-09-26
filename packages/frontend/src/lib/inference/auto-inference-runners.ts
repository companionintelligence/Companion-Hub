import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

export type AutomaticInferenceRunner = 'omlx' | 'vllm' | 'ollama';

export type AutomaticInferenceRunnerState = 'already_running' | 'installed_and_started' | 'installed' | 'skipped' | 'failed';

export interface AutomaticInferenceRunnerResult {
  runner: AutomaticInferenceRunner | string;
  state: AutomaticInferenceRunnerState;
  endpointUrl?: string;
  detail?: string;
}

export const DEFAULT_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['ollama'];

/** Apple Silicon first-run set. oMLX handles chat and embeddings. */
export const DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['omlx'];

const AUTOMATIC_RUNNERS_BY_BACKEND: Record<string, AutomaticInferenceRunner[]> = {
  omlx: DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS,
  vllm: ['vllm', 'ollama'],
  lemonade: ['ollama'],
  ollama: ['ollama'],
};

export function automaticRunnersForBackend(backend: string): AutomaticInferenceRunner[] {
  return AUTOMATIC_RUNNERS_BY_BACKEND[backend] ?? DEFAULT_AUTOMATIC_INFERENCE_RUNNERS;
}

/**
 * Ask the desktop shell to install and launch host inference runners.
 * A browser build has no native process boundary, so it is a no-op there.
 */
export async function installAndStartInferenceRunners(
  runners: AutomaticInferenceRunner[] = DEFAULT_AUTOMATIC_INFERENCE_RUNNERS,
): Promise<AutomaticInferenceRunnerResult[]> {
  const invoke = getTauriInvoke();
  if (!invoke) return [];
  const result = await invoke('install_and_start_inference_runners_command', { backends: runners });
  return Array.isArray(result) ? (result as AutomaticInferenceRunnerResult[]) : [];
}
