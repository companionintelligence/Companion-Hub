import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/**
 * Whether this computer's AI servers (Ollama, vLLM) can be reached from the network, as the desktop
 * app sees it (`hub_manager::installers::inference_guard`). On Linux they listen on every interface
 * so the Hub container can reach them over the Docker bridge, and Ollama has no login, so without
 * the desktop's network guard anyone on the same Wi-Fi or LAN could use them.
 */
export interface LocalAiNetworkExposure {
  listeningOnAllInterfaces: boolean;
  guarded: boolean;
  /** The desktop can turn the guard on and off here (Linux with pkexec, or a WSL engine). */
  canProtect: boolean;
  /** The person turned the guard off: on the network by choice. */
  disabledByUser: boolean;
}

/** Null outside the desktop app, or when it cannot tell. */
export async function fetchLocalAiNetworkExposure(): Promise<LocalAiNetworkExposure | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    return (await invoke('local_ai_network_exposure_command')) as LocalAiNetworkExposure;
  } catch {
    // A desktop app from before the command, or a page the IPC grant does not cover.
    return null;
  }
}

/** Ask the desktop to install the guard. It asks for the computer's password. */
export async function protectLocalAi(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) throw new Error('Only the Companion Hub desktop app can do this.');
  await invoke('protect_local_ai_command');
}

/** Ask the desktop to turn the guard off, and remember that. It asks for the computer's password. */
export async function allowLocalAiOnNetwork(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) throw new Error('Only the Companion Hub desktop app can do this.');
  await invoke('allow_local_ai_on_network_command');
}

/**
 * - `exposed`: reachable from the network, not by choice. Warn.
 * - `guarded`: the guard is on.
 * - `open-by-choice`: the person turned the guard off.
 * - `none`: nothing to say (nothing listens everywhere, or this is not the desktop app).
 */
export type LocalAiNetworkState = 'exposed' | 'guarded' | 'open-by-choice' | 'none';

export function localAiNetworkState(exposure: LocalAiNetworkExposure | null): LocalAiNetworkState {
  if (!exposure) return 'none';
  if (exposure.guarded) return 'guarded';
  if (exposure.disabledByUser) return 'open-by-choice';
  return exposure.listeningOnAllInterfaces ? 'exposed' : 'none';
}
