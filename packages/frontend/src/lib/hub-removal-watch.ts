import { checkForRemoval } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

/** How often Settings asks the Hub whether the Portal removed it. The Hub itself checks in at most every 30 seconds. */
export const HUB_REMOVAL_WATCH_INTERVAL_MS = 15_000;

/** How long Settings keeps asking before it stops and lets the person try again. */
export const HUB_REMOVAL_WATCH_TIMEOUT_MS = 15 * 60_000;

/** What one check found. `not_allowed` is the Hub refusing the check itself, such as an expired session. */
export type HubRemovalCheck = 'removed' | 'still_registered' | 'key_refused' | 'not_checked' | 'not_allowed';

/** Why a watch ended. */
export type HubRemovalWatchEnd = 'removed' | 'key_refused' | 'not_allowed' | 'timed_out';

const CHECK_RESULTS: readonly HubRemovalCheck[] = ['removed', 'still_registered', 'key_refused', 'not_checked'];

/**
 * The Portal page that asks an owner or admin to confirm deleting this device.
 *
 * Deleting it there removes the device's web addresses and apps from the account. The Hub finds
 * out on its next check-in, which is what the watch below speeds up.
 */
export function portalRemoveDeviceUrl(portalUrl: string, deviceId: string): string {
  return `${portalUrl.replace(/\/+$/, '')}/home?remove_device=${encodeURIComponent(deviceId)}`;
}

/** Asks the Hub for one removal check. Network and server failures read as `not_checked`, so the watch keeps going. */
export async function checkHubRemoval(): Promise<HubRemovalCheck> {
  try {
    const response = await sdkResult(checkForRemoval());

    if (response.status === 401 || response.status === 403) {
      return 'not_allowed';
    }

    const result = (response.data as { result?: unknown } | undefined)?.result;

    return response.ok && CHECK_RESULTS.includes(result as HubRemovalCheck) ? (result as HubRemovalCheck) : 'not_checked';
  } catch {
    return 'not_checked';
  }
}

type WatchOptions = {
  check?: () => Promise<HubRemovalCheck>;
  onEnd: (end: HubRemovalWatchEnd) => void;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * Checks right away, then every interval, until the Portal removes this Hub, refuses its key,
 * the Hub refuses the check, or the timeout passes. Returns a function that stops the watch
 * without calling `onEnd`.
 *
 * Checks never overlap: the next one is scheduled only after the previous one answers.
 */
export function watchForHubRemoval({
  check = checkHubRemoval,
  onEnd,
  intervalMs = HUB_REMOVAL_WATCH_INTERVAL_MS,
  timeoutMs = HUB_REMOVAL_WATCH_TIMEOUT_MS,
  now = Date.now,
}: WatchOptions): () => void {
  const deadline = now() + timeoutMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const end = (reason: HubRemovalWatchEnd) => {
    if (stopped) {
      return;
    }
    stopped = true;
    onEnd(reason);
  };

  const tick = async () => {
    if (stopped) {
      return;
    }
    if (now() >= deadline) {
      end('timed_out');
      return;
    }

    let result: HubRemovalCheck;
    try {
      result = await check();
    } catch {
      result = 'not_checked';
    }

    if (stopped) {
      return;
    }
    if (result === 'removed' || result === 'key_refused' || result === 'not_allowed') {
      end(result);
      return;
    }

    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
