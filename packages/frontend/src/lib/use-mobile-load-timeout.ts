import { getHubBaseUrlSync, isMobileClient } from '@/lib/mobile-connection';
import { useEffect, useState } from 'react';

const DEFAULT_MS = 6_000;

export function shouldTimeBoxMobileLoads(): boolean {
  return isMobileClient() || import.meta.env.VITE_HUB_RUNTIME === 'mobile' || Boolean(getHubBaseUrlSync());
}

/** True when a mobile spinner has been up longer than `ms` — show an error instead. */
export function useMobileLoadTimeout(busy: boolean, ms = DEFAULT_MS): boolean {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!shouldTimeBoxMobileLoads() || !busy) {
      setTimedOut(false);
      return;
    }
    const id = globalThis.setTimeout(() => setTimedOut(true), ms);
    return () => globalThis.clearTimeout(id);
  }, [busy, ms]);

  return timedOut;
}
