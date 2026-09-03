/** Canonical shell colors — match docs/UI-STYLE-GUIDE.md dark/light `--background`. */
export const SHELL_BACKGROUND = {
  dark: '#041620',
  light: '#f3f3f3',
} as const;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function resolveIsDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** Keep the native window/webview background aligned with the CSS shell token. */
export async function syncTauriWindowBackground(): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const color = resolveIsDark() ? SHELL_BACKGROUND.dark : SHELL_BACKGROUND.light;
    await getCurrentWindow().setBackgroundColor(color);
  } catch (error) {
    // Older desktop builds may lack the capability; CSS `--background` still applies.
    if (import.meta.env.DEV) {
      console.warn('Failed to sync Tauri window background', error);
    }
  }
}
