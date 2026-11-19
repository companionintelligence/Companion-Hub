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
  /** The desktop can install the guard here (Linux with pkexec). */
  canProtect: boolean;
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

export function isExposedToNetwork(exposure: LocalAiNetworkExposure | null): boolean {
  return Boolean(exposure?.listeningOnAllInterfaces && !exposure.guarded);
}
