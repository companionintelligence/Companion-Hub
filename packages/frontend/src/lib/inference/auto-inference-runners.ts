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
