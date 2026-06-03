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
  getAppQueryKey: ({ path }: { path: { urn: string } }) => ['getApp', path.urn],
}));

describe('handleAppSseEvent', () => {
  let queryClient: {
    invalidateQueries: ReturnType<typeof vi.fn>;
    setQueryData: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = {
      invalidateQueries: vi.fn(),
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
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates installed and app queries on status transition without progress', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'running',
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', null);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('invalidates on install_success', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'install_success',
      appUrn: 'plane:ci-marketplace',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['app-install-error', 'plane:ci-marketplace'], null);
  });
});
