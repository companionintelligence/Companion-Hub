import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY } from '@/lib/cloudflare-api';
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
  getCustomDomainsQueryKey: () => ['getCustomDomains'],
  getServeStatusQueryKey: () => ['getServeStatus'],
  getStatus3QueryKey: () => ['getStatus3'],
}));

/**
 * Queries `invalidateAppQueries` refreshes for one app: installed apps, installed
 * urns, the app row, app context, and the Public Web report that says whether a
 * bound custom domain is still dark.
 */
const INVALIDATED_PER_APP_EVENT = 5;

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

  it('refetches the Tailscale status and the served ports when tailscaled starts or stops refusing the Hub (CI-Hub#1766)', () => {
    for (const denied of [true, false]) {
      queryClient.invalidateQueries.mockClear();

      handleAppSseEvent(queryClient as unknown as QueryClient, { event: 'tailscale_serve_permission', denied });

      // Settings → Network and every Private VPN access card read the refusal from the Tailscale status.
      expect(queryClient.invalidateQueries.mock.calls.map(([filters]) => filters.queryKey)).toEqual([['getStatus3'], ['getServeStatus']]);
    }
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
    expect(updateInstallationProgress).not.toHaveBeenCalled();
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

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', { percent: 42 });
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('passes the download size along with the progress', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'installing',
      progress: 70,
      downloadedBytes: 400,
      totalBytes: 1_500,
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', { percent: 70, downloadedBytes: 400, totalBytes: 1_500 });
  });

  it('invalidates installed and app queries on status transition without progress', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'status_change',
      appUrn: 'plane:ci-marketplace',
      appStatus: 'running',
    });

    expect(updateInstallationProgress).toHaveBeenCalledWith('plane:ci-marketplace', null);
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['getApp', 'plane:ci-marketplace'], expect.any(Function));
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(INVALIDATED_PER_APP_EVENT);
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

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(INVALIDATED_PER_APP_EVENT);
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
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(INVALIDATED_PER_APP_EVENT);
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
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(INVALIDATED_PER_APP_EVENT);
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

  it('refetches the custom-domain listing as well as the app on custom_domain_changed', () => {
    // The picker disables options and names the domains another Hub holds from the listing, not from the app row.
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'custom_domain_changed',
      appUrn: 'comfyui:ci-marketplace',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['getCustomDomains'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['getApp', 'comfyui:ci-marketplace'] });
  });

  it('refetches the Public Web report under the key every surface reads it by', () => {
    // A bare call count cannot see this: any fifth key satisfies it. The dashboard
    // banner, the app page banner and the tile badge all mount
    // `PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY`, so a hand-written literal here would leave
    // all three asking for a restart that has already happened.
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'custom_domain_changed',
      appUrn: 'comfyui:ci-marketplace',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY });
  });

  it('refetches the app and the Public Web report when its public domain moved', () => {
    // The row's public domain changed, so every URL the app page and the Public Web
    // report show was composed from the old one.
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'public_domain_changed',
      appUrn: 'n8n:ci-marketplace',
      hostname: 'n8n-core-2-acme.ci.computer',
    });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['getApp', 'n8n:ci-marketplace'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY });
    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['getCustomDomains'] });
  });

  it('leaves the custom-domain listing alone on other lifecycle events', () => {
    handleAppSseEvent(queryClient as unknown as QueryClient, {
      event: 'restart_success',
      appUrn: 'comfyui:ci-marketplace',
      appStatus: 'running',
    });

    expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['getCustomDomains'] });
  });
});
