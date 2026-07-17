import { client } from '@/api-client/client.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { isMemoryProviderUrn } from '@/modules/app/helpers/memory-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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

/** An installed app still holding a live Companion Memory connection. */
export interface MemoryConsumer {
  appUrn: string;
  name: string;
}

export const MEMORY_CONSUMERS_QUERY_KEY = ['memory-connect-consumers'];

/**
 * The installed apps still connected to Companion Memory (GET
 * /api/memory-connect/consumers). Used to warn — and gate a forced confirmation —
 * before uninstalling or resetting the shared provider. `enabled` keeps it from
 * firing except when the dialog for the provider itself is open.
 */
export function useMemoryConsumers(enabled: boolean) {
  return useQuery({
    queryKey: MEMORY_CONSUMERS_QUERY_KEY,
    enabled,
    queryFn: async () => {
      // throwOnError: the generated client resolves (not rejects) on non-2xx by
      // default, which would mask a failed fetch as `data: undefined`.
      const { data } = await client.get({ url: '/api/memory-connect/consumers', throwOnError: true });
      return ((data as { consumers?: MemoryConsumer[] } | undefined)?.consumers ?? []) as MemoryConsumer[];
    },
    staleTime: 15_000,
  });
}

export interface MemoryProviderForceGate {
  /** True when the target app is the memory provider and a forced confirmation is required. */
  requiresForce: boolean;
  /** The connected consumer apps (empty when there are none, or when the list couldn't be fetched). */
  consumers: MemoryConsumer[];
  /** True when the target is the provider but the consumer list couldn't be loaded. */
  unableToVerify: boolean;
  forceConfirmed: boolean;
  setForceConfirmed: (checked: boolean) => void;
  /** Whether the dialog's confirm button should be disabled. */
  submitDisabled: boolean;
}

/**
 * Shared uninstall/reset gating for the Companion Memory provider. Centralizes
 * the logic both destructive dialogs need so they can't drift: detects the
 * provider, fetches its connected consumers while the dialog is open, and drives
 * the forced-confirmation switch.
 *
 * Fails CLOSED: if the target is the provider but the consumer list can't be
 * fetched, `requiresForce`/`unableToVerify` stay true, so the UI still demands an
 * explicit confirmation instead of silently letting a `force:false` submit
 * through (the backend guard is authoritative, but the UI shouldn't look like a
 * safe "no consumers" dialog when it actually doesn't know).
 */
export function useMemoryProviderForceGate(appUrn: string, isOpen: boolean): MemoryProviderForceGate {
  const isProvider = isMemoryProviderUrn(appUrn);
  const consumersQuery = useMemoryConsumers(isOpen && isProvider);
  const consumers = consumersQuery.data ?? [];
  const unableToVerify = isProvider && consumersQuery.isError;
  const requiresForce = isProvider && (consumers.length > 0 || unableToVerify);

  const [forceConfirmed, setForceConfirmed] = useState(false);

  // Re-arm the acknowledgement whenever the dialog (re)opens OR the target app
  // changes, so a prior confirmation can never carry into a different destructive
  // action. `appUrn` is intentionally a re-run trigger even though the body
  // doesn't read it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appUrn is a deliberate reset trigger, not a value the effect reads.
  useEffect(() => {
    if (isOpen) {
      setForceConfirmed(false);
    }
  }, [isOpen, appUrn]);

  const submitDisabled = (isProvider && consumersQuery.isLoading) || (requiresForce && !forceConfirmed);

  return { requiresForce, consumers, unableToVerify, forceConfirmed, setForceConfirmed, submitDisabled };
}

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

    // The connect consent round-trip (start → ci-memory consent → callback →
    // finishing interstitial) runs entirely on the Hub's PUBLIC tunnel origin and
    // needs an authenticated session there. In the desktop app the webview is
    // served from the bundled LOCAL origin (tauri://localhost) and wrapped by the
    // HubStatus gate, which depends on the Tauri IPC plus a 127.0.0.1 health probe.
    // A `window.location.href` navigation would throw the webview onto the remote
    // origin, where the Tauri IPC is permission-denied and the localhost probe is
    // unreachable — so HubStatus falls back to "Stopped" and the whole flow
    // collapses to the "Hub Not Running" gate. Hand the flow to the system browser
    // instead (the same escape the Open button uses); `next` is omitted so the
    // backend returns to the app's own public URL.
    if (getTauriInvoke()) {
      void openExternal(status.connectUrl);

      // The consent completes in that separate browser, so this webview never
      // reloads (unlike the web path's full-page return to `next`). Refetch this
      // app's status the first time the user returns to the desktop window, so the
      // button reflects the new connection (→ "Disconnect"). One-shot `focus`
      // listener: it fires on native window refocus and removes itself. We
      // invalidate (not just mark stale) so the refetch isn't suppressed by
      // staleTime. TanStack's refetchOnWindowFocus is unfit here — it only hooks
      // `visibilitychange`, which a non-occluded desktop window may never emit,
      // and it's gated by staleTime.
      const refetchOnReturn = () => {
        window.removeEventListener('focus', refetchOnReturn);
        void queryClient.invalidateQueries({ queryKey: memoryStatusQueryKey(appUrn) });
      };
      window.addEventListener('focus', refetchOnReturn);
      return;
    }

    // Web: same-origin navigation — return to this app-detail page after the
    // connection is applied.
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
