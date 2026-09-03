import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { handleAppSseEvent } from '../app-sse-cache';
import { installQueueQueryKey } from '../install-queue';
import { updateInstallationProgress } from '../use-installation-progress';

vi.mock('../use-installation-progress', () => ({
  updateInstallationProgress: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsQueryKey: () => ['getInstalledApps'],
  getInstalledAppUrnsQueryKey: () => ['getInstalledAppUrns'],
  getAppQueryKey: ({ path }: { path: { urn: string } }) => ['getApp', path.urn],
  appContextQueryKey: () => ['appContext'],
}));

describe('handleAppSseEvent', () => {
  let queryClient: {
    cancelQueries: ReturnType<typeof vi.fn>;
    invalidateQueries: ReturnType<typeof vi.fn>;
    removeQueries: ReturnType<typeof vi.fn>;
    setQueryData: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = {
      cancelQueries: vi.fn(),
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
      setQueryData: vi.fn(),
    };
  });

  it('updates install queue cache without invalidating queries', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'install_queue',
      active: { urn: 'plane:ci-marketplace', name: 'Plane' },
      queued: [{ urn: 'cloudreve:ci-marketplace', name: 'Cloudreve' }],
    });

    expect(queryClient.setQueryData).toHaveBeenCalledWith(installQueueQueryKey, {
      active: { urn: 'plane:ci-marketplace', name: 'Plane' },
      queued: [{ urn: 'cloudreve:ci-marketplace', name: 'Cloudreve' }],
    });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('updates progress only for installing status_change with progress', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'installing',
      progress: 42,
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', 42);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates installed and app queries on status transition without progress', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'running',
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', null);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(4);
  });

  it('refreshes install queue when an app enters installing', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'installing',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: installQueueQueryKey });
  });

  it('invalidates on install_success', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'install_success',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'running',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(4);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'plane:ci-marketplace'], null);
  });

  it('clears app and runtime-health caches on uninstall_success', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'uninstall_success',
      appUrn: 'plane:ci-marketplace',
    });

    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'plane:ci-marketplace'], null);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: ['app-runtime-health', 'plane:ci-marketplace'] });
    expect(queryClient.removeQueries).toHaveBeenCalledWith({ queryKey: ['app-runtime-health', 'plane:ci-marketplace'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(4);
  });

  it('clears caches and progress on install_cancelled (like uninstall)', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'install_cancelled',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'missing',
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', null);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'plane:ci-marketplace'], null);
    // App record is cleared (set to { app: null }) just like an uninstall.
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.removeQueries).toHaveBeenCalledWith({ queryKey: ['app-runtime-health', 'plane:ci-marketplace'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(4);
  });

  it('ignores transient stopped status_change while the app is restarting', () => {
    queryClient.setQueryData.mockImplementation((key, updater) => {
      if (key[0] === 'getApp') {
        const current = {
          app: {
            urn: 'plane:ci-marketplace',
            status: 'restarting',
          },
        };
        if (typeof updater === 'function') {
          updater(current);
        }
      }
    });

    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'stopped',
    });

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('clears a stale install-error banner when a later start_success lands the app on running', () => {
    // Regression: an install that failed once (banner cached under app-install-error) followed by a
    // successful manual start/restart previously left the banner stuck — start_success/restart_success
    // never flowed through the status_change branch that clears it.
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'start_success',
      appUrn: 'safeos:ci-marketplace',
      appStatus: 'running',
    });

    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'safeos:ci-marketplace'], null);
  });

  it('clears a stale install-error banner on restart_success landing on running', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'restart_success',
      appUrn: 'safeos:ci-marketplace',
      appStatus: 'running',
    });

    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'safeos:ci-marketplace'], null);
  });

  it('does not touch the install-error cache on stop_success (app is not running)', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'stop_success',
      appUrn: 'safeos:ci-marketplace',
      appStatus: 'stopped',
    });

    expect(queryClient.setQueryData).not.toHaveBeenCalledWith(['app-install-error', 'safeos:ci-marketplace'], null);
  });
});
