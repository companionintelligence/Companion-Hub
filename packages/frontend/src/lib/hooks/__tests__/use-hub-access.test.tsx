import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn<(path: string) => Promise<Response>>() }));

vi.mock('@/lib/api-fetch', () => ({ apiFetch }));

import { useHubAccess } from '../use-hub-access';

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('useHubAccess', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it('says an owner or admin may manage the Hub, as the Hub answers', async () => {
    apiFetch.mockResolvedValue(answer(200, { manageHub: true }));

    const { result } = renderHook(() => useHubAccess(), { wrapper: wrapper() });

    expect(result.current).toEqual({ manageHub: false, isPending: true });
    await waitFor(() => expect(result.current).toEqual({ manageHub: true, isPending: false }));
    expect(apiFetch).toHaveBeenCalledWith('/api/hub-access');
  });

  it('says a member may not', async () => {
    apiFetch.mockResolvedValue(answer(200, { manageHub: false }));

    const { result } = renderHook(() => useHubAccess(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.manageHub).toBe(false);
  });

  it('offers nothing when the Hub does not answer', async () => {
    apiFetch.mockResolvedValue(answer(503, { message: 'unavailable' }));

    const { result } = renderHook(() => useHubAccess(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.manageHub).toBe(false);
  });
});
