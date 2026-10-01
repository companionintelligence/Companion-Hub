import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { type DesktopRestartState, getDesktopRestartState, isTauri, restartDesktopApp } from '@/lib/update-service';
import { isTauriMobileSync } from '@/lib/mobile-connection';

/** How often to ask the desktop app whether an update replaced it. The check is a file lookup. */
export const RESTART_CHECK_INTERVAL_MS = 60_000;

/**
 * Says once when an update installs another desktop app version while this one is open. The open
 * app keeps running the old version until it restarts, and opening it again from the app menu
 * only brought the old window back, so nothing else shows that a restart is needed. Settings →
 * System → Desktop app keeps the same message and button for as long as it applies.
 */
export function useDesktopRestartNotice(): void {
  const { t } = useTranslation();
  const notifiedFor = useRef<string | null>(null);

  const showNotice = useCallback(
    (state: DesktopRestartState) => {
      const toastId = 'desktop-restart-required';
      const handleRestart = async () => {
        toast.dismiss(toastId);
        // On success the app exits; it only comes back here when the restart was refused.
        if (!(await restartDesktopApp())) {
          toast.error(t('DESKTOP_RESTART_FAILED'));
        }
      };
      toast.info(
        <span className="flex flex-col gap-1">
          <strong>
            {state.installedVersion
              ? t('DESKTOP_RESTART_TOAST_TITLE', { version: state.installedVersion })
              : t('DESKTOP_RESTART_TOAST_TITLE_UNKNOWN_VERSION')}
          </strong>
          <span>{t('DESKTOP_RESTART_TOAST_BODY', { running: state.runningVersion })}</span>
          <span className="flex gap-2 mt-1">
            <button type="button" className="underline font-medium" onClick={() => void handleRestart()}>
              {t('DESKTOP_RESTART_NOW')}
            </button>
            <button type="button" className="text-muted-foreground underline" onClick={() => toast.dismiss(toastId)}>
              {t('UPDATE_TOAST_LATER')}
            </button>
          </span>
        </span>,
        { id: toastId, duration: Number.POSITIVE_INFINITY },
      );
    },
    [t],
  );

  useEffect(() => {
    if (!isTauri() || isTauriMobileSync()) return;
    let cancelled = false;

    const check = async () => {
      const state = await getDesktopRestartState();
      if (cancelled || !state?.restartRequired) return;
      const installed = state.installedVersion ?? 'unknown';
      if (notifiedFor.current === installed) return;
      notifiedFor.current = installed;
      showNotice(state);
    };

    void check();
    const interval = window.setInterval(() => void check(), RESTART_CHECK_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [showNotice]);
}
