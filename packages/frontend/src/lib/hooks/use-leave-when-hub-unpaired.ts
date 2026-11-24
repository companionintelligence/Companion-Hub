import { useEffect } from 'react';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { getHubBaseUrlSync, isMobileClient } from '@/lib/mobile-connection';
import { handleSessionExpired } from '@/lib/session-expired';

/**
 * How long "unpaired" has to last before an open page acts on it. A Hub that just started answers
 * `unregistered` once before it reads its registration back, so a single answer proves nothing. It
 * also gives a page that leaves for pairing by itself (a reset, a removal it watched for) time to go.
 */
export const UNPAIRED_CONFIRM_MS = 3_000;

/**
 * Sends a signed-in page on when the Hub stops being paired while it is open: the device deleted in
 * the Portal, a reset from another tab or from `cihub`. The redirect to pairing used to live only in
 * the root loader, which an open page doesn't run again, so Home and Settings stayed up on an
 * unpaired Hub until a reload (#2556).
 *
 * It goes the way an ended session does, to sign-in. On an unpaired Hub the root loader sends that on
 * to pairing. A phone signed in to a remote Hub is left alone: its root loader never looks at
 * pairing, so sign-in would let it straight back in and this would send it out again.
 */
export function useLeaveWhenHubUnpaired(): void {
  const { data: status, refetch } = useRegistrationStatus();
  const remoteHubOnPhone = isMobileClient() && Boolean(getHubBaseUrlSync());
  const unpaired = !remoteHubOnPhone && status?.phase === 'unregistered';

  useEffect(() => {
    if (!unpaired) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const confirm = () => {
      timer = setTimeout(() => {
        void refetch().then((result) => {
          if (cancelled) {
            return;
          }
          // A failed check keeps the last answer as `data`. That is the `unregistered` being checked,
          // so it proves nothing: ask again after the delay.
          if (result.isError) {
            confirm();
            return;
          }
          if (result.data?.phase === 'unregistered') {
            void handleSessionExpired();
          }
        });
      }, UNPAIRED_CONFIRM_MS);
    };
    confirm();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [unpaired, refetch]);
}
