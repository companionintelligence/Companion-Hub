import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { syncExposure } from '@/api-client/sdk.gen';
import { mcpAdminStatusQueryKey, tailscaleStatusQueryKey } from '@/api-client/routes/named-status-routes';
import { useTailscaleReadinessSync, type TailscaleReadinessStatus } from './use-tailscale-readiness-sync';

vi.mock('@/api-client/sdk.gen', () => ({
  syncExposure: vi.fn().mockResolvedValue({ data: {}, response: { ok: true } }),
}));

const mockSyncExposure = vi.mocked(syncExposure);

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** A wrapper that also hands back every queryKey the hook invalidates. */
function createSpyingWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters, options) => {
    invalidated.push(filters?.queryKey);
    return original(filters, options);
  });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { wrapper, invalidated };
}

describe('useTailscaleReadinessSync', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not sync on the initial status sample', async () => {
    const status: TailscaleReadinessStatus = { installed: true, connected: true, httpsAvailable: true };

    renderHook(() => useTailscaleReadinessSync(status), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(mockSyncExposure).not.toHaveBeenCalled();
    });
  });

  it('syncs when Tailscale transitions to connected', async () => {
    const { rerender } = renderHook(({ status }: { status: TailscaleReadinessStatus }) => useTailscaleReadinessSync(status), {
      wrapper: createWrapper(),
      initialProps: { status: { installed: true, connected: false, httpsAvailable: false } },
    });

    rerender({ status: { installed: true, connected: true, httpsAvailable: false } });

    await waitFor(() => {
      expect(mockSyncExposure).toHaveBeenCalled();
    });
  });

  // The hook used to invalidate getStatus5QueryKey() — /api/mcp-admin/status — while the
  // Private VPN card reads tailscaleStatusQueryKey(). The sync fired and refreshed nothing.
  // Nothing failed, because both keys are valid; they just name different routes. Asserting
  // that syncExposure was called could never have caught it, which is why it did not.
  it('invalidates the Tailscale status key, not the MCP admin one', async () => {
    const { wrapper, invalidated } = createSpyingWrapper();
    const { rerender } = renderHook(({ status }: { status: TailscaleReadinessStatus }) => useTailscaleReadinessSync(status), {
      wrapper,
      initialProps: { status: { installed: true, connected: false, httpsAvailable: false } },
    });

    rerender({ status: { installed: true, connected: true, httpsAvailable: false } });

    await waitFor(() => {
      expect(mockSyncExposure).toHaveBeenCalled();
    });

    await waitFor(() => {
      const keys = invalidated.map((k) => JSON.stringify(k));
      expect(keys).toContain(JSON.stringify(tailscaleStatusQueryKey()));
      expect(keys).not.toContain(JSON.stringify(mcpAdminStatusQueryKey()));
    });
  });

  it('syncs when HTTPS becomes available on an already-connected tailnet', async () => {
    const { rerender } = renderHook(({ status }: { status: TailscaleReadinessStatus }) => useTailscaleReadinessSync(status), {
      wrapper: createWrapper(),
      initialProps: { status: { installed: true, connected: true, httpsAvailable: false } },
    });

    rerender({ status: { installed: true, connected: true, httpsAvailable: true } });

    await waitFor(() => {
      expect(mockSyncExposure).toHaveBeenCalled();
    });
  });
});
