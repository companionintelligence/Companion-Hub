// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/shell.ts
/**
 * Shell detection: which wrapper is hosting this web bundle, and on which platform.
 *
 * Takes the global object as a parameter, so tests can pass a fake. A browser has no
 * secure store, so the web kind is only a label. Nothing here reads storage.
 */

export type ShellKind = 'tauri' | 'capacitor' | 'web';
export type ShellPlatform = 'ios' | 'android' | 'desktop' | 'web';

export interface ShellInfo {
  readonly kind: ShellKind;
  readonly platform: ShellPlatform;
}

/** The parts of the global object that detection reads. */
export interface ShellGlobal {
  /** Set by the Tauri runtime in every webview it hosts. */
  readonly __TAURI_INTERNALS__?: unknown;
  /** Set by the Capacitor runtime. */
  readonly Capacitor?: {
    readonly isNativePlatform?: () => boolean;
    readonly getPlatform?: () => string;
  };
  readonly navigator?: { readonly userAgent?: string };
}

/**
 * Tauri reports no platform of its own, so the user agent decides. iPadOS can present
 * a desktop user agent, so treat 'desktop' as a hint, not a guarantee.
 */
function tauriPlatform(userAgent: string): ShellPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return 'desktop';
}

/**
 * Detect the wrapper. Tauri is checked first, then Capacitor with `isNativePlatform()`
 * set to true. Anything else is a plain web page.
 */
export function detectShell(scope: ShellGlobal = globalThis): ShellInfo {
  if ('__TAURI_INTERNALS__' in scope) {
    return { kind: 'tauri', platform: tauriPlatform(scope.navigator?.userAgent ?? '') };
  }

  const capacitor = scope.Capacitor;
  if (capacitor?.isNativePlatform?.() === true) {
    const platform = capacitor.getPlatform?.();
    return { kind: 'capacitor', platform: platform === 'ios' || platform === 'android' ? platform : 'web' };
  }

  return { kind: 'web', platform: 'web' };
}
