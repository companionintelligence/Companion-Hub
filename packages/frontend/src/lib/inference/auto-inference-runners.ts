import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

export type AutomaticInferenceRunner = 'omlx' | 'vllm' | 'ollama';

export type AutomaticInferenceRunnerState = 'already_running' | 'installed_and_started' | 'installed' | 'skipped' | 'failed';

export interface AutomaticInferenceRunnerResult {
  runner: AutomaticInferenceRunner | string;
  state: AutomaticInferenceRunnerState;
  endpointUrl?: string;
  detail?: string;
  /**
   * A runner's API key. For oMLX, its main key: the one the desktop app set when it installed oMLX, or
   * the one oMLX already has. The Hub needs it to download models through oMLX's admin API. For vLLM,
   * the key the desktop app started it with, which the Hub must send.
   */
  apiKey?: string;
  /** What to know about a runner that otherwise works, such as an oMLX the desktop app could not give a key. */
  warning?: string;
}

export const DEFAULT_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['ollama'];

/** Apple Silicon first-run set. oMLX serves chat, and Ollama serves embeddings: the catalog has no oMLX embedder. */
export const DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS: AutomaticInferenceRunner[] = ['omlx', 'ollama'];

const AUTOMATIC_RUNNERS_BY_BACKEND: Record<string, AutomaticInferenceRunner[]> = {
  omlx: DEFAULT_MACOS_AUTOMATIC_INFERENCE_RUNNERS,
  vllm: ['vllm', 'ollama'],
  lemonade: ['ollama'],
  ollama: ['ollama'],
};

export function automaticRunnersForBackend(backend: string): AutomaticInferenceRunner[] {
  return AUTOMATIC_RUNNERS_BY_BACKEND[backend] ?? DEFAULT_AUTOMATIC_INFERENCE_RUNNERS;
}

/** What the desktop app answers when it gave oMLX a key: the key, shown once, and a warning when oMLX took only part of it. */
export interface OmlxAdminKeySetup {
  apiKey: string;
  warning?: string;
}

/**
 * Ask the desktop app to give the oMLX on this Mac its first main key. Rejects with oMLX's reason
 * when it already has one or does not listen on loopback alone, and in a browser.
 */
export async function setUpOmlxAdminKey(): Promise<OmlxAdminKeySetup> {
  const invoke = getTauriInvoke();
  if (!invoke) throw new Error('Only the desktop app can set a key for oMLX.');
  const result = (await invoke('omlx_setup_admin_key_command')) as OmlxAdminKeySetup | null;
  if (!result?.apiKey) throw new Error('The desktop app did not return a key.');
  return result;
}

/**
 * Whether oMLX's own settings on this Mac hold a main key, as the desktop app reads them. `null` when
 * it cannot say: in a browser, or a desktop app too old to have the command.
 */
export async function omlxAdminKeyIsSet(): Promise<boolean | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    const result = (await invoke('omlx_admin_key_status_command')) as { keySet?: unknown } | null;
    return typeof result?.keySet === 'boolean' ? result.keySet : null;
  } catch {
    return null;
  }
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
