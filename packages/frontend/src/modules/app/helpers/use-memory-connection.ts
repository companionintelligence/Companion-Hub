import { client } from '@/api-client/client.gen';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** Mirrors the backend MemoryConnectUiStatus (GET /api/memory-connect/apps/:urn/status). */
export interface MemoryConnectionStatus {
  applicable: boolean;
  memoryInstalled: boolean;
  state: 'unconfigured' | 'connected' | 'skipped' | 'manual';
  connectUrl: string | null;
  /** ISO instant the key expires (when connected); the Hub auto-rotates before this. */
  keyExpiresAt: string | null;
}

export const memoryStatusQueryKey = (appUrn: string) => ['memory-connection-status', appUrn];

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
    connectUrl: status?.connectUrl ?? null,
    connect,
    disconnect: () => disconnect.mutate(),
    isDisconnecting: disconnect.isPending,
  };
}
