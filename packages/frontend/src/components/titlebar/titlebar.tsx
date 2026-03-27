import { useEffect, useState } from 'react';
import type { Window } from '@tauri-apps/api/window';

export function Titlebar() {
  const [isTauri, setIsTauri] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [appWindow, setAppWindow] = useState<Window | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    setIsTauri(true);

    import('@tauri-apps/api/window')
      .then((mod) => {
        const win = mod.getCurrentWindow();
        setAppWindow(win);
        win.isMaximized().then(setIsMaximized);
        win.onResized(() => {
          win.isMaximized().then(setIsMaximized);
        });
      })
      .catch(console.warn);

    import('@tauri-apps/plugin-os')
      .then((mod) => mod.type())
      .then((os) => setIsMac(os === 'macos'))
      .catch(console.warn);
  }, []);

  if (!isTauri || !appWindow) return null;

  const controls = (
    <div className="flex h-full">
      <button
        type="button"
        aria-label="Minimize window"
        onClick={() => appWindow.minimize()}
        className="inline-flex h-full w-[46px] items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true" focusable="false">
          <title>Minimize</title>
          <path d="M0 0.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        onClick={() => appWindow.toggleMaximize()}
        className="inline-flex h-full w-[46px] items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <title>Restore</title>
            <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <title>Maximize</title>
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={() => appWindow.close()}
        className="inline-flex h-full w-[46px] items-center justify-center hover:bg-[#c42b1c] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <title>Close</title>
          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );

  return (
    <div className="flex h-10 select-none border-b bg-background" data-tauri-drag-region>
      {isMac ? controls : null}
      <div className="flex flex-1 items-center gap-2 px-3" data-tauri-drag-region>
        <img src="/icons/favicon-96x96.png" alt="CI Hub" className="h-5 w-5" />
        <span className="text-sm font-medium text-foreground">Companion Hub</span>
      </div>
      {isMac ? null : controls}
    </div>
  );
}
