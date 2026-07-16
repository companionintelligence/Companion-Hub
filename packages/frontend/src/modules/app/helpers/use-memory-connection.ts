import { client } from '@/api-client/client.gen';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** Coarse ci-memory lifecycle, mirrors the backend MemoryProviderRuntimeStatus. */
export type MemoryProviderStatus = 'ready' | 'starting' | 'offline' | 'absent';

/** Mirrors the backend MemoryConnectUiStatus (GET /api/memory-connect/apps/:urn/status). */
export interface MemoryConnectionStatus {
  applicable: boolean;
  /** A ci-memory row exists (installing/stopped included) — else nothing to connect to. */
  memoryInstalled: boolean;
  /** ci-memory is actually running, i.e. a connect can succeed right now. */
  memoryReady: boolean;
  /** Why it isn't ready, so the UI can say "starting" vs "offline". */
  providerStatus: MemoryProviderStatus;
  state: 'unconfigured' | 'connected' | 'skipped' | 'manual';
  connectUrl: string | null;
  /** ISO instant the key expires (when connected); the Hub auto-rotates before this. */
  keyExpiresAt: string | null;
}

/** Query-key prefix, shared with the SSE cache so ci-memory events can invalidate every consumer's status. */
export const MEMORY_STATUS_QUERY_PREFIX = 'memory-connection-status';
export const memoryStatusQueryKey = (appUrn: string) => [MEMORY_STATUS_QUERY_PREFIX, appUrn];

/**
 * Shared Companion Memory connection state for an app, used by both the
 * app-detail status badge and the Connect/Disconnect action button. Both call
 * this with the same `appUrn`, so they share one react-query cache entry (a
 * single network request). The connect action is a full-page navigation into
 * the Hub launcher (which drives the consent flow); disconnect revokes + clears
 * via the backend.
 */
export function useMemoryConnection(appUrn: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: memoryStatusQueryKey(appUrn),
    queryFn: async () => {
      // throwOnError: the generated client resolves (not rejects) on non-2xx by
      // default, which would mask a failed status fetch as `data: undefined`.
      const { data } = await client.get({ url: `/api/memory-connect/apps/${encodeURIComponent(appUrn)}/status`, throwOnError: true });
      return (data ?? null) as MemoryConnectionStatus | null;
    },
    staleTime: 15_000,
    // While Companion Memory is actively coming up ('starting': installing / booting
    // / mid-maintenance), poll so the badge + Connect button flip to ready shortly
    // after it does — the status is keyed by THIS app's urn, so ci-memory's own
    // status change doesn't refetch it on its own. The SSE cache also invalidates
    // this on ci-memory lifecycle events (instant); this is the safety net if one is
    // missed. Deliberately NOT polling while 'offline' (stopped/failed) or 'ready':
    // those are settled states, and offline→ready is driven by a start event the SSE
    // cache already catches, so polling them would just burn requests indefinitely.
    refetchInterval: (q) => {
      const data = q.state.data as MemoryConnectionStatus | null | undefined;
      return data?.applicable && data.providerStatus === 'starting' ? 10_000 : false;
    },
  });

  const disconnect = useMutation({
    // throwOnError so a non-2xx disconnect rejects into onError instead of
    // silently firing the success toast while the app stays connected.
    mutationFn: () => client.post({ url: `/api/memory-connect/apps/${encodeURIComponent(appUrn)}/disconnect`, throwOnError: true }),
    onSuccess: async () => {
      toast.success(t('MEMORY_CONNECT_DISCONNECTED_TOAST'));
      await queryClient.invalidateQueries({ queryKey: memoryStatusQueryKey(appUrn) });
    },
    onError: () => toast.error(t('MEMORY_CONNECT_DISCONNECT_ERROR')),
  });

  const status = query.data ?? null;

  const connect = () => {
    if (!status?.connectUrl) {
      return;
    }

    // Return to this app-detail page after the connection is applied.
    window.location.href = `${status.connectUrl}&next=${encodeURIComponent(window.location.href)}`;
  };

  return {
    /** True only once the status has loaded and the app is a memory consumer. */
    applicable: !query.isLoading && !!status?.applicable,
    isLoading: query.isLoading,
    connected: status?.state === 'connected',
    memoryInstalled: !!status?.memoryInstalled,
    /** ci-memory is running — a connect can succeed now. */
    memoryReady: !!status?.memoryReady,
    /** Coarse provider lifecycle for precise "starting"/"offline" copy. */
    providerStatus: status?.providerStatus ?? 'absent',
    connectUrl: status?.connectUrl ?? null,
    connect,
    disconnect: () => disconnect.mutate(),
    isDisconnecting: disconnect.isPending,
  };
}
