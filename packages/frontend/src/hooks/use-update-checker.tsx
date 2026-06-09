import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router';
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

function showUpdateToast(info: UpdateInfo, onDismiss: () => void) {
  toast(
    (t) => (
      <span className="flex flex-col gap-1 text-sm">
        <strong>Companion Hub {info.latestVersion}</strong> is available.
        <span className="flex gap-2 mt-1">
          <Link to="/settings" className="underline font-medium" onClick={() => toast.dismiss(t.id)}>
            Open Settings
          </Link>
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => {
              onDismiss();
              toast.dismiss(t.id);
            }}
          >
            Later
          </button>
        </span>
      </span>
    ),
    { duration: 8000, id: `hub-update-${info.latestVersion}` },
  );
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const runCheck = useCallback(async (showToast = true) => {
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

      if (showToast && result.updateAvailable && !wasToastShown(result.latestVersion)) {
        markToastShown(result.latestVersion);
        showUpdateToast(result, () => dismissVersion(result.latestVersion));
      }

      return result;
    } finally {
      setChecking(false);
    }
  }, []);

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
