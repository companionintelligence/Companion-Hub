/** Canonical shell colors — match docs/UI-STYLE-GUIDE.md dark/light `--background`. */
export const SHELL_BACKGROUND = {
  dark: '#041620',
  light: '#f3faf7',
} as const;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function resolveIsDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

/**
 * The background the page is really showing, as `#rrggbb`. Read from the document
 * instead of from the theme class, so it is right even when the two disagree.
 */
function renderedBackground(fallback: string): string {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(getComputedStyle(document.documentElement).backgroundColor);
  if (!match || match[4] === '0') return fallback;
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The Android app keeps the page clear of the status and navigation bars, which leaves
 * two strips showing the native window. `window.CiHubSystemBars` (SystemBars.kt) paints
 * them; absent everywhere else.
 */
function paintAndroidSystemBars(fallback: string): void {
  const bridge = (window as Window & { CiHubSystemBars?: { setBackgroundColor(color: string): void } }).CiHubSystemBars;
  if (!bridge) return;
  try {
    bridge.setBackgroundColor(renderedBackground(fallback));
  } catch {
    // The strips keep their last colour; the page itself is unaffected.
  }
}

/** Keep the native window/webview background aligned with the CSS shell token. */
export async function syncTauriWindowBackground(): Promise<void> {
  if (typeof window === 'undefined') return;

  const color = resolveIsDark() ? SHELL_BACKGROUND.dark : SHELL_BACKGROUND.light;
  paintAndroidSystemBars(color);
  if (!isTauriRuntime()) return;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setBackgroundColor(color);
  } catch (error) {
    // Older desktop builds may lack the capability; CSS `--background` still applies.
    if (import.meta.env.DEV) {
      console.warn('Failed to sync Tauri window background', error);
    }
  }
}
