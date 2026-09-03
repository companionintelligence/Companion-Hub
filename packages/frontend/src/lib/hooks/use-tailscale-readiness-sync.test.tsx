import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { syncExposure } from '@/api-client/sdk.gen';
import { useTailscaleReadinessSync, type TailscaleReadinessStatus } from './use-tailscale-readiness-sync';

vi.mock('@/api-client/sdk.gen', () => ({
  syncExposure: vi.fn().mockResolvedValue({ data: {}, response: { ok: true } }),
}));

const mockSyncExposure = vi.mocked(syncExposure);

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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
