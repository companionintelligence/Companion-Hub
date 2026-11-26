import { useEffect } from 'react';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { getHubBaseUrlSync, isMobileClient } from '@/lib/mobile-connection';
import { handleSessionExpired } from '@/lib/session-expired';

/**
 * How long "unpaired" has to last before an open page acts on it. A Hub that has just started says
 * `starting` until it has read its registration back (#2590), which this leaves alone. One
 * `unregistered` still isn't enough to sign someone out on, so the check asks once more.
 */
export const UNPAIRED_CONFIRM_MS = 3_000;

let holds = 0;

/**
 * Holds the hook back while a page leaves for pairing by itself: Settings while it resets the Hub or
 * waits for the Portal to remove it. That page says what happened on its way out. The Hub turns
 * `unregistered` as soon as a reset starts, so the hook used to cut that page short whenever the reset
 * ran long. It nearly always did when a check-in found the removal before the watch did. Returns the
 * release, which may be called more than once.
 */
export function holdLeaveWhenHubUnpaired(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      holds -= 1;
    }
  };
}

/**
 * Sends a signed-in page on when the Hub stops being paired while it is open: the device deleted in
 * the Portal, a reset from another tab or from `cihub`. The redirect to pairing used to live only in
 * the root loader, which an open page doesn't run again, so Home and Settings stayed up on an
 * unpaired Hub until a reload (#2556).
 *
 * It goes the way an ended session does, to sign-in. On an unpaired Hub the root loader sends that on
 * to pairing. It clears what Settings clears when it leaves for pairing: a drift choice kept from the
 * last pairing hid the pairing page's question about the device the Portal still lists. A phone
 * signed in to a remote Hub is left alone: its root loader never looks at pairing, so sign-in would
 * let it straight back in and this would send it out again.
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
          if (result.data?.phase !== 'unregistered') {
            return;
          }
          // A page leaving for pairing by itself goes first. Ask again in case it stops.
          if (holds > 0) {
            confirm();
            return;
          }
          clearClientHubState({ keepPortalEmail: true });
          void handleSessionExpired();
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
