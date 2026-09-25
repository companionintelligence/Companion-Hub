import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  checkForUpdates,
  dismissVersion,
  getPollIntervalMs,
  isTauri,
  isVersionDismissed,
  markToastShown,
  type UpdateInfo,
  wasToastShown,
} from '@/lib/update-service';
import { isTauriMobileSync } from '@/lib/mobile-connection';

export type { UpdateInfo } from '@/lib/update-service';

/**
 * The iOS/Android app ships through the App Store and Play, so it must never
 * offer an update from our own feed — the artifacts are desktop .dmg/.exe
 * builds it cannot install, and self-updating outside the store is an App
 * Store rejection (guidelines 2.4.5 / 3.2.2).
 *
 * `isTauri()` is true on mobile, so this needs saying explicitly. It happens to
 * be inert there today only because the mobile Rust shell never registers
 * `get_desktop_release_version_command` and the invoke rejects — add a version
 * command for any reason and the phone starts advertising desktop downloads.
 */
const canSelfUpdate = (): boolean => isTauri() && !isTauriMobileSync();

export interface UseUpdateCheckerResult {
  update: UpdateInfo | null;
  dismiss: () => void;
  recheck: () => Promise<UpdateInfo | null>;
  checking: boolean;
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const showUpdateToast = useCallback(
    (info: UpdateInfo, onDismiss: () => void) => {
      const toastId = `hub-update-${info.latestVersion}`;
      toast.info(
        <span className="flex flex-col gap-1">
          <strong>{t('UPDATE_TOAST_AVAILABLE', { version: info.latestVersion })}</strong>
          <span className="flex gap-2 mt-1">
            <Link to="/settings" className="underline font-medium" onClick={() => toast.dismiss(toastId)}>
              {t('UPDATE_TOAST_OPEN_SETTINGS')}
            </Link>
            <button
              type="button"
              className="text-muted-foreground underline"
              onClick={() => {
                onDismiss();
                toast.dismiss(toastId);
              }}
            >
              {t('UPDATE_TOAST_LATER')}
            </button>
          </span>
        </span>,
        { id: toastId, duration: 8000 },
      );
    },
    [t],
  );

  const runCheck = useCallback(
    async (showToastNotification = true) => {
      if (!canSelfUpdate()) return null;
      setChecking(true);
      try {
        const result = await checkForUpdates();
        if (!result) {
          setUpdate(null);
          return null;
        }

        if (result.updateAvailable && isVersionDismissed(result.latestVersion)) {
          setUpdate(null);
          return result;
        }

        setUpdate(result.updateAvailable ? result : null);

        if (showToastNotification && result.updateAvailable && !wasToastShown(result.latestVersion)) {
          markToastShown(result.latestVersion);
          showUpdateToast(result, () => dismissVersion(result.latestVersion));
        }

        return result;
      } catch {
        // The poll and the mount both call this as `void runCheck(true)`, so a
        // throw here escapes as an unhandled rejection rather than reaching
        // anyone who could act on it. An update check is best-effort: a bad
        // feed response should look the same as "nothing to report".
        setUpdate(null);
        return null;
      } finally {
        setChecking(false);
      }
    },
    [showUpdateToast],
  );

  const dismiss = useCallback(() => {
    setUpdate((prev) => {
      if (prev) dismissVersion(prev.latestVersion);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!canSelfUpdate()) return;

    void runCheck(true);

    intervalRef.current = window.setInterval(() => {
      void runCheck(true);
    }, getPollIntervalMs());

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
      }
    };
  }, [runCheck]);

  const recheck = useCallback(async () => runCheck(false), [runCheck]);

  return { update, dismiss, recheck, checking };
}
