import type { GetAppDto } from '@/api-client';
import { getAppQueryKey, getInstalledAppsQueryKey, appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { AppUrn } from '@ci-hub/common/types';
import type { QueryClient } from '@tanstack/react-query';
import { installQueueQueryKey, type InstallQueueState } from './install-queue';
import { CI_MEMORY_APP_NAME } from './memory-provider';
import { MEMORY_STATUS_QUERY_PREFIX } from './use-memory-connection';
import { updateInstallationProgress } from './use-installation-progress';

// Reserved app-directory name of Companion Memory (shared with the provider gate).
// When ci-memory itself changes lifecycle state, every consumer app's
// memory-connection status can flip (installing→ready, running→offline, …) — but
// those queries are keyed by the CONSUMER's urn, so ci-memory's own SSE event
// never touches them on its own.

export type AppInstallErrorCache = {
  message: string;
  ts: number;
  errorCode?: string;
  errorDetail?: string;
  settingsPath?: string;
};

export type AppSsePayload = {
  event: string;
  appUrn?: string;
  appStatus?: string;
  error?: string;
  errorCode?: string;
  errorDetail?: string;
  settingsPath?: string;
  /** Translation key for a non-fatal caveat on an otherwise-successful op (rendered as a warning toast). */
  warningCode?: string;
  progress?: number;
  active?: InstallQueueState['active'];
  queued?: InstallQueueState['queued'];
};

const LIFECYCLE_INVALIDATE_EVENTS = new Set([
  'install_success',
  'install_error',
  'start_success',
  'start_error',
  'stop_success',
  'stop_error',
  'restart_success',
  'restart_error',
  'update_success',
  'update_error',
  'reset_success',
  'reset_error',
  'uninstall_success',
  'uninstall_error',
  'backup_success',
  'backup_error',
  'restore_success',
  'restore_error',
  'generate_env_success',
  'generate_env_error',
]);

const TERMINAL_PROGRESS_STATUSES = new Set(['running', 'missing', 'install_failed']);

/** Lifecycle states where a transient Docker `stopped` snapshot must not clobber UI. */
const TRANSITIONAL_APP_STATUSES = new Set([
  'installing',
  'uninstalling',
  'stopping',
  'starting',
  'updating',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
]);

function shouldApplyGenericStatusChange(currentStatus: string | undefined, nextStatus: string): boolean {
  if (!currentStatus || currentStatus === nextStatus) {
    return true;
  }

  if (TRANSITIONAL_APP_STATUSES.has(currentStatus) && (nextStatus === 'stopped' || nextStatus === 'missing')) {
    return false;
  }

  return true;
}

function runtimeHealthQueryKey(appUrn: string) {
  return ['app-runtime-health', appUrn];
}

/**
 * Refetch everything that describes one app. Also the canonical way to unwind an optimistic install
 * write: `onMutate` forces the app to `installing` in several caches at once, and a request that
 * fails before the backend starts work emits no SSE event and none of these queries poll — so
 * without this they keep spinning on a status that will never arrive.
 */
export function invalidateAppQueries(queryClient: QueryClient, appUrn: string) {
  void queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getAppQueryKey({ path: { urn: appUrn } }) });
  void queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
}

function setCachedAppStatus(
  queryClient: QueryClient,
  appUrn: string,
  appStatus?: string,
  options?: { allowDowngradeFromTransitional?: boolean },
): 'applied' | 'rejected' | 'no-cache' {
  if (!appStatus) {
    return 'no-cache';
  }

  let outcome: 'applied' | 'rejected' | 'no-cache' = 'no-cache';

  queryClient.setQueryData(getAppQueryKey({ path: { urn: appUrn } }), (current: GetAppDto | undefined) => {
    if (!current?.app) {
      return current;
    }

    const allowDowngrade = options?.allowDowngradeFromTransitional ?? false;
    if (!allowDowngrade && !shouldApplyGenericStatusChange(current.app.status, appStatus)) {
      outcome = 'rejected';
      return current;
    }

    outcome = 'applied';
    return {
      ...current,
      app: {
        ...current.app,
        status: appStatus,
      },
    };
  });

  return outcome;
}

function clearUninstalledAppCaches(queryClient: QueryClient, appUrn: string) {
  queryClient.setQueryData(getAppQueryKey({ path: { urn: appUrn } }), (current: GetAppDto | undefined) => {
    if (!current) {
      return current;
    }

    return {
      ...current,
      app: null,
    };
  });
  void queryClient.cancelQueries({ queryKey: runtimeHealthQueryKey(appUrn) });
  queryClient.removeQueries({ queryKey: runtimeHealthQueryKey(appUrn) });
}

function updateInstallErrorCache(
  queryClient: QueryClient,
  appUrn: string,
  payload: Pick<AppSsePayload, 'error' | 'errorCode' | 'errorDetail' | 'settingsPath'>,
  appStatus?: string,
) {
  if (!appUrn) return;

  if (appStatus === 'install_failed' && payload.error) {
    queryClient.setQueryData<AppInstallErrorCache>(['app-install-error', appUrn], {
      message: payload.error,
      ts: Date.now(),
      errorCode: payload.errorCode,
      errorDetail: payload.errorDetail,
      settingsPath: payload.settingsPath,
    });
    return;
  }

  queryClient.setQueryData(['app-install-error', appUrn], null);
}

/**
 * Apply targeted React Query cache updates for app-topic SSE events.
 * Progress-only install ticks do not invalidate queries.
 */
export function handleAppSseEvent(queryClient: QueryClient, data: AppSsePayload) {
  const { event, appUrn, appStatus, error, errorCode, errorDetail, settingsPath } = data;
  const progress = data.progress;

  if (event === 'install_queue') {
    queryClient.setQueryData(installQueueQueryKey, {
      active: data.active ?? null,
      queued: data.queued ?? [],
    });
    return;
  }

  if (!appUrn) {
    return;
  }

  const urn = appUrn as AppUrn;

  // If Companion Memory itself changed lifecycle, nudge every consumer's memory
  // status (keyed by the consumer's urn, so the provider's own event misses them).
  // Skip pure install-progress ticks — the status is stably "starting" throughout,
  // so refetching on each tick would be wasted work.
  if (appUrn.split(':')[0] === CI_MEMORY_APP_NAME) {
    const isInstallProgressTick = event === 'status_change' && appStatus === 'installing' && typeof progress === 'number';
    if (!isInstallProgressTick) {
      void queryClient.invalidateQueries({ queryKey: [MEMORY_STATUS_QUERY_PREFIX] });
    }
  }

  if (event === 'install_error' && error) {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    queryClient.setQueryData<AppInstallErrorCache>(['app-install-error', urn], {
      message: error,
      ts: Date.now(),
      errorCode,
      errorDetail,
      settingsPath,
    });
    updateInstallationProgress(urn, null);
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (event === 'install_success') {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    queryClient.setQueryData(['app-install-error', urn], null);
    updateInstallationProgress(urn, null);
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (event === 'uninstall_success') {
    queryClient.setQueryData(['app-install-error', urn], null);
    updateInstallationProgress(urn, null);
    clearUninstalledAppCaches(queryClient, appUrn);
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  // A cancelled install removes the partial app record — treat it like an uninstall so the UI
  // returns to the not-installed (store) state instead of leaving a stale "installing" card.
  if (event === 'install_cancelled') {
    queryClient.setQueryData(['app-install-error', urn], null);
    updateInstallationProgress(urn, null);
    clearUninstalledAppCaches(queryClient, appUrn);
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (LIFECYCLE_INVALIDATE_EVENTS.has(event)) {
    setCachedAppStatus(queryClient, appUrn, appStatus, { allowDowngradeFromTransitional: true });
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (event !== 'status_change') {
    return;
  }

  if (appStatus === 'installing' && typeof progress === 'number') {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    updateInstallationProgress(urn, progress);
    return;
  }

  if (appStatus === 'installing' && progress === undefined) {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    updateInstallErrorCache(queryClient, appUrn, { error, errorCode, errorDetail, settingsPath }, appStatus);
    void queryClient.invalidateQueries({ queryKey: installQueueQueryKey });
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (appStatus && TERMINAL_PROGRESS_STATUSES.has(appStatus)) {
    updateInstallationProgress(urn, null);
  }

  if (appStatus === 'install_failed' && error) {
    queryClient.setQueryData<AppInstallErrorCache>(['app-install-error', urn], {
      message: error,
      ts: Date.now(),
      errorCode,
      errorDetail,
      settingsPath,
    });
  } else if (appStatus === 'running' || appStatus === 'missing' || appStatus === 'installing') {
    queryClient.setQueryData(['app-install-error', urn], null);
  }

  if (appStatus) {
    const outcome = setCachedAppStatus(queryClient, appUrn, appStatus);
    if (outcome !== 'rejected') {
      invalidateAppQueries(queryClient, appUrn);
    }
  }
}
