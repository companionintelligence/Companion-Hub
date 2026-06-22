import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
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

export type { UpdateInfo } from '@/lib/update-service';

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
      toast(
        (toastInstance) => (
          <span className="flex flex-col gap-1 text-sm">
            <strong>{t('UPDATE_TOAST_AVAILABLE', { version: info.latestVersion })}</strong>
            <span className="flex gap-2 mt-1">
              <Link to="/settings" className="underline font-medium" onClick={() => toast.dismiss(toastInstance.id)}>
                {t('UPDATE_TOAST_OPEN_SETTINGS')}
              </Link>
              <button
                type="button"
                className="text-muted-foreground underline"
                onClick={() => {
                  onDismiss();
                  toast.dismiss(toastInstance.id);
                }}
              >
                {t('UPDATE_TOAST_LATER')}
              </button>
            </span>
          </span>
        ),
        { duration: 8000, id: `hub-update-${info.latestVersion}` },
      );
    },
    [t],
  );

  const runCheck = useCallback(
    async (showToastNotification = true) => {
      if (!isTauri()) return null;
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
    if (!isTauri()) return;

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
