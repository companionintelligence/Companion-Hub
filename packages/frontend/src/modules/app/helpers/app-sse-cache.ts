import type { GetAppDto } from '@/api-client';
import { getAppQueryKey, getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { AppUrn } from '@ci-hub/common/types';
import type { QueryClient } from '@tanstack/react-query';
import { installQueueQueryKey, type InstallQueueState } from './install-queue';
import { updateInstallationProgress } from './use-installation-progress';

export type AppSsePayload = {
  event: string;
  appUrn?: string;
  appStatus?: string;
  error?: string;
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

function runtimeHealthQueryKey(appUrn: string) {
  return ['app-runtime-health', appUrn];
}

function invalidateAppQueries(queryClient: QueryClient, appUrn: string) {
  void queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getAppQueryKey({ path: { urn: appUrn } }) });
}

function setCachedAppStatus(queryClient: QueryClient, appUrn: string, appStatus?: string) {
  if (!appStatus) {
    return;
  }

  queryClient.setQueryData(getAppQueryKey({ path: { urn: appUrn } }), (current: GetAppDto | undefined) => {
    if (!current?.app) {
      return current;
    }

    return {
      ...current,
      app: {
        ...current.app,
        status: appStatus,
      },
    };
  });
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

function updateInstallErrorCache(queryClient: QueryClient, appUrn: string, error: string | undefined, appStatus?: string) {
  if (!appUrn) return;

  if (appStatus === 'install_failed' && error) {
    queryClient.setQueryData(['app-install-error', appUrn], { message: error, ts: Date.now() });
    return;
  }

  queryClient.setQueryData(['app-install-error', appUrn], null);
}

/**
 * Apply targeted React Query cache updates for app-topic SSE events.
 * Progress-only install ticks do not invalidate queries.
 */
export function handleAppSseEvent(queryClient: QueryClient, data: AppSsePayload) {
  const { event, appUrn, appStatus, error } = data;
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

  if (event === 'install_error' && error) {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    queryClient.setQueryData(['app-install-error', urn], { message: error, ts: Date.now() });
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

  if (LIFECYCLE_INVALIDATE_EVENTS.has(event)) {
    setCachedAppStatus(queryClient, appUrn, appStatus);
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
    updateInstallErrorCache(queryClient, appUrn, error, appStatus);
    invalidateAppQueries(queryClient, appUrn);
    return;
  }

  if (appStatus && TERMINAL_PROGRESS_STATUSES.has(appStatus)) {
    updateInstallationProgress(urn, null);
  }

  if (appStatus === 'install_failed' && error) {
    queryClient.setQueryData(['app-install-error', urn], { message: error, ts: Date.now() });
  } else if (appStatus === 'running' || appStatus === 'missing' || appStatus === 'installing') {
    queryClient.setQueryData(['app-install-error', urn], null);
  }

  if (appStatus) {
    setCachedAppStatus(queryClient, appUrn, appStatus);
    invalidateAppQueries(queryClient, appUrn);
  }
}
