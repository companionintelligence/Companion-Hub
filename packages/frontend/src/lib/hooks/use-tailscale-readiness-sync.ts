import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { apiFetch } from '@/lib/api-fetch';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export interface TailscaleReadinessStatus {
  installed?: boolean;
  connected?: boolean;
  httpsAvailable?: boolean;
}

export async function requestTailscaleExposureSync(): Promise<void> {
  const res = await apiFetch('/api/tailscale/sync', { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Tailscale sync failed: HTTP ${res.status}`);
  }
}

/**
 * When Tailscale connects or HTTPS/Serve becomes available, ask the backend to
 * re-publish Private VPN apps and refresh client-side context.
 */
export function useTailscaleReadinessSync(status: TailscaleReadinessStatus | undefined, enabled = true): void {
  const queryClient = useQueryClient();
  const initializedRef = useRef(false);
  const prevConnectedRef = useRef<boolean | null>(null);
  const prevHttpsRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!enabled || !status) {
      return;
    }

    const connected = Boolean(status.installed && status.connected);
    const httpsAvailable = Boolean(status.httpsAvailable);

    if (!initializedRef.current) {
      initializedRef.current = true;
      prevConnectedRef.current = connected;
      prevHttpsRef.current = httpsAvailable;
      return;
    }

    const becameConnected = !prevConnectedRef.current && connected;
    const becameHttpsReady = !prevHttpsRef.current && httpsAvailable;
    prevConnectedRef.current = connected;
    prevHttpsRef.current = httpsAvailable;

    if (connected && (becameConnected || becameHttpsReady)) {
      void requestTailscaleExposureSync()
        .then(() =>
          Promise.all([
            queryClient.invalidateQueries({ queryKey: appContextQueryKey() }),
            queryClient.invalidateQueries({ queryKey: ['tailscale-serve'] }),
            queryClient.invalidateQueries({ queryKey: ['tailscale-status'] }),
          ]),
        )
        .catch(() => undefined);
    }
  }, [enabled, status, queryClient, status?.connected, status?.httpsAvailable, status?.installed]);
}
