import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useTailscaleReadinessSync, type TailscaleReadinessStatus } from './use-tailscale-readiness-sync';

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

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
      expect(apiFetch).not.toHaveBeenCalled();
    });
  });

  it('syncs when Tailscale transitions to connected', async () => {
    const { rerender } = renderHook(({ status }) => useTailscaleReadinessSync(status), {
      wrapper: createWrapper(),
      initialProps: { status: { installed: true, connected: false, httpsAvailable: false } satisfies TailscaleReadinessStatus },
    });

    rerender({ status: { installed: true, connected: true, httpsAvailable: false } });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/tailscale/sync', { method: 'POST' });
    });
  });

  it('syncs when HTTPS becomes available on an already-connected tailnet', async () => {
    const { rerender } = renderHook(({ status }) => useTailscaleReadinessSync(status), {
      wrapper: createWrapper(),
      initialProps: { status: { installed: true, connected: true, httpsAvailable: false } satisfies TailscaleReadinessStatus },
    });

    rerender({ status: { installed: true, connected: true, httpsAvailable: true } });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/tailscale/sync', { method: 'POST' });
    });
  });
});
