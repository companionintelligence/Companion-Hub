import { useEffect, useRef, useState } from 'react';
import type { Window } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { isTauriMobileSync } from '@/lib/mobile-connection';
import { retryDynamicImport } from '@/lib/chunk-load-error';

/**
 * Is this macOS, decided SYNCHRONOUSLY.
 *
 * tauri-plugin-os injects __TAURI_OS_PLUGIN_INTERNALS__ into every page with a
 * js_init_script, so the OS is known before React first renders -- no chunk
 * fetch, no IPC, no ACL involved.
 *
 * This used to come from `import('@tauri-apps/plugin-os').then(m => m.type())`
 * with a `.catch(console.warn)`. When that dynamic chunk was slow or failed --
 * and root.tsx already handles 'vite:preloadError' as a known event in this app
 * -- two things went wrong at once: --titlebar-height stayed at its 0px default,
 * so the `fixed z-50` header painted straight over the titlebar and its drag
 * region; and isMac stayed false, so macOS rendered the Windows/Linux bar
 * underneath the native traffic lights.
 */
function detectIsMac(): boolean {
  const os = (window as unknown as { __TAURI_OS_PLUGIN_INTERNALS__?: { os_type?: string } }).__TAURI_OS_PLUGIN_INTERNALS__;
  if (os?.os_type) return os.os_type === 'macos';
  // Pre-Tauri-2.3 shells did not inject os_type; the UA is good enough to pick a
  // titlebar shape, and is still synchronous.
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/**
 * The bar's height, and the value of --titlebar-height that the header, dialogs and page layout
 * are placed by. The bar is sized from this too: as `h-10` (2.5rem, 42.5px at this app's 17px root)
 * it was 2.5px taller than the layout allowed for, so every page ran 2.5px past the window.
 */
const TITLEBAR_HEIGHT_PX = { mac: 28, other: 40 } as const;

/**
 * While a dialog, menu or select is open, Radix sets `pointer-events: none` on <body> and closes
 * the open layer on any press outside it. The bar inherited both: a press went through it to the
 * dialog's backdrop, which closed the dialog, and the window buttons and drag region never saw it.
 * The bar opts back in to pointer events and keeps its presses from reaching the document.
 */
const KEEP_POINTER_EVENTS = { pointerEvents: 'auto' } as const;

export function Titlebar() {
  const { t } = useTranslation(undefined, { useSuspense: false });
  // Mobile has no OS window chrome — the desktop titlebar (and its window-control
  // IPC like window.is_maximized) doesn't apply and isn't permitted there.
  const isDesktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !isTauriMobileSync();
  // Both known on the FIRST render, so the titlebar and its drag region exist
  // immediately and --titlebar-height is never left at 0px.
  const [isMac] = useState(() => isDesktopShell && detectIsMac());
  const [isTauri] = useState(isDesktopShell);
  const [isMaximized, setIsMaximized] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // Radix watches `pointerdown` on the document. A React onPointerDown can't stop it: the app hydrates the
    // whole document, so React's own listener sits on the document as well. Tauri starts a window drag
    // from `mousedown`, which this leaves alone.
    const keepOpenLayers = (event: PointerEvent) => event.stopPropagation();
    bar.addEventListener('pointerdown', keepOpenLayers);
    return () => bar.removeEventListener('pointerdown', keepOpenLayers);
  }, []);

  useEffect(() => {
    if (!isDesktopShell) return;
    document.documentElement.style.setProperty('--titlebar-height', `${isMac ? TITLEBAR_HEIGHT_PX.mac : TITLEBAR_HEIGHT_PX.other}px`);
  }, [isDesktopShell, isMac]);

  useEffect(() => {
    if (!isDesktopShell) return;

    retryDynamicImport(() => import('@tauri-apps/api/window'))
      .then(async (mod) => {
        const win = mod.getCurrentWindow();
        setAppWindow(win);
        // Remote hub URLs loaded inside the desktop webview used to reject these
        // IPC calls ("not allowed by ACL") as unhandled promise rejections when
        // capabilities lacked a remote URL allowlist — swallow ACL denials here.
        try {
          setIsMaximized(await win.isMaximized());
        } catch {
          /* ACL / older shell — titlebar still renders without maximize state */
        }
        // Debounce isMaximized checks on Windows/Linux — calling isMaximized()
        // with decorations:false can be expensive. On macOS this is handled
        // natively via titleBarStyle: overlay so no onResized listener needed.
        try {
          await win.onResized(() => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              void win
                .isMaximized()
                .then(setIsMaximized)
                .catch(() => undefined);
            }, 150);
          });
        } catch {
          /* ACL / older shell */
        }
      })
      .catch(console.warn);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isDesktopShell]);

  // On macOS with titleBarStyle: overlay, the native traffic lights handle
  // minimize/maximize/close. We only need a transparent spacer for layout offset.
  if (!isTauri) return null;
  if (isMac) {
    // A spacer holding the native overlay traffic-light band clear of the app
    // header. `relative z-[60]` so the `fixed z-50` header (components/header)
    // can never paint over it.
    return (
      <div
        ref={barRef}
        className="relative z-[60] w-full"
        style={{ ...KEEP_POINTER_EVENTS, height: TITLEBAR_HEIGHT_PX.mac }}
        data-tauri-drag-region
      />
    );
  }

  // Windows/Linux: custom titlebar with window controls.
  //
  // NOTE: this deliberately does NOT bail out while `appWindow` is still loading.
  // It used to `return null` until the dynamic import of @tauri-apps/api/window
  // resolved -- and on Windows/Linux main.rs strips the native decorations, so
  // for that whole window there was no titlebar, no drag region and no way to
  // move the window at all. If the import never resolved, that was permanent.
  // The bar and its drag region render immediately; only the three window
  // controls wait for the IPC handle they actually need.
  return (
    <div
      ref={barRef}
      className="relative z-[60] flex select-none border-b bg-background"
      style={{ ...KEEP_POINTER_EVENTS, height: TITLEBAR_HEIGHT_PX.other }}
    >
      <div className="flex flex-1 items-center gap-2 px-3" data-tauri-drag-region>
        <img src="/icons/favicon-96x96.png" alt={t('APP_NAME')} className="h-5 w-5 pointer-events-none" />
        <span className="text-sm font-medium text-foreground pointer-events-none">{t('APP_NAME')}</span>
      </div>
      {/* The controls need the IPC handle; the drag region above does not. */}
      <div className="flex h-full" hidden={!appWindow}>
        <button
          type="button"
          aria-label={t('TITLEBAR_MINIMIZE_WINDOW')}
          onClick={() => appWindow?.minimize()}
          className="inline-flex h-full w-[46px] items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true" focusable="false">
            <title>{t('TITLEBAR_MINIMIZE')}</title>
            <path d="M0 0.5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={isMaximized ? t('TITLEBAR_RESTORE_WINDOW') : t('TITLEBAR_MAXIMIZE_WINDOW')}
          onClick={() => appWindow?.toggleMaximize()}
          className="inline-flex h-full w-[46px] items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <title>{t('COMMON_RESTORE')}</title>
              <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" />
              <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <title>{t('TITLEBAR_MAXIMIZE')}</title>
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          aria-label={t('TITLEBAR_CLOSE_WINDOW')}
          onClick={() => appWindow?.close()}
          className="inline-flex h-full w-[46px] items-center justify-center hover:bg-[#c42b1c] hover:text-white"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <title>{t('COMMON_CLOSE')}</title>
            <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
