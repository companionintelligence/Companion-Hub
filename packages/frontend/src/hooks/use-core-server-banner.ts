import { useCallback, useState } from 'react';

export interface UseCoreServerBannerResult {
  isDismissed: boolean;
  dismiss: () => void;
}

export function useCoreServerBanner(probeUpdatedAt: number | undefined): UseCoreServerBannerResult {
  const [dismissedForUpdatedAt, setDismissedForUpdatedAt] = useState<number | undefined>(undefined);

  const isDismissed = probeUpdatedAt !== undefined && dismissedForUpdatedAt === probeUpdatedAt;

  const dismiss = useCallback(() => {
    if (probeUpdatedAt !== undefined) {
      setDismissedForUpdatedAt(probeUpdatedAt);
    }
  }, [probeUpdatedAt]);

  return { isDismissed, dismiss };
}
