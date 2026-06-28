import { useEffect, useRef, useState } from 'react';
import type { Window } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { isTauriMobileSync } from '@/lib/mobile-connection';

export function Titlebar() {
  const { t } = useTranslation(undefined, { useSuspense: false });
  // Mobile has no OS window chrome — the desktop titlebar (and its window-control
  // IPC like window.is_maximized) doesn't apply and isn't permitted there.
  const [isTauri, setIsTauri] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const [isMac, setIsMac] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window) || isTauriMobileSync()) return;
    setIsTauri(true);

    import('@tauri-apps/plugin-os')
      .then((mod) => mod.type())
      .then((os) => {
        const mac = os === 'macos';
        setIsMac(mac);
        // On macOS we use native titleBarStyle: overlay — no custom titlebar needed.
        // Only set the CSS offset for the overlay traffic lights area.
        if (mac) {
          document.documentElement.style.setProperty('--titlebar-height', '28px');
        } else {
          document.documentElement.style.setProperty('--titlebar-height', '40px');
        }
      })
      .catch(console.warn);

    import('@tauri-apps/api/window')
      .then((mod) => {
        const win = mod.getCurrentWindow();
        setAppWindow(win);
        win.isMaximized().then(setIsMaximized);
        // Debounce isMaximized checks on Windows/Linux — calling isMaximized()
        // with decorations:false can be expensive. On macOS this is handled
        // natively via titleBarStyle: overlay so no onResized listener needed.
        win.onResized(() => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            win.isMaximized().then(setIsMaximized);
          }, 150);
        });
      })
      .catch(console.warn);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // On macOS with titleBarStyle: overlay, the native traffic lights handle
  // minimize/maximize/close. We only need a transparent spacer for layout offset.
  if (!isTauri) return null;
  if (isMac) {
    return <div className="h-7 w-full" data-tauri-drag-region />;
  }

  // Windows/Linux: custom titlebar with window controls
  if (!appWindow) return null;

  return (
    <div className="flex h-10 select-none border-b bg-background">
      <div className="flex flex-1 items-center gap-2 px-3" data-tauri-drag-region>
        <img src="/icons/favicon-96x96.png" alt={t('APP_NAME')} className="h-5 w-5 pointer-events-none" />
        <span className="text-sm font-medium text-foreground pointer-events-none">{t('APP_NAME')}</span>
      </div>
      <div className="flex h-full">
        <button
          type="button"
          aria-label={t('TITLEBAR_MINIMIZE_WINDOW')}
          onClick={() => appWindow.minimize()}
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
          onClick={() => appWindow.toggleMaximize()}
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
          onClick={() => appWindow.close()}
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
