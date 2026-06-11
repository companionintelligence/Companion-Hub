export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Returns the Tauri IPC invoke function when running inside the desktop app,
 * or null in a plain browser (web client) — callers use this to gate
 * desktop-only actions like native installers.
 */
export function getTauriInvoke(): TauriInvoke | null {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return (window as unknown as { __TAURI_INTERNALS__: { invoke: TauriInvoke } }).__TAURI_INTERNALS__.invoke;
  }
  return null;
}
