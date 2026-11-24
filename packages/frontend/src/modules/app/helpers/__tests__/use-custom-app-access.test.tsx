import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn<(path: string) => Promise<Response>>() }));

vi.mock('@/lib/api-fetch', () => ({ apiFetch }));

import { useCustomAppAccess } from '../use-custom-app-access';

const wrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('useCustomAppAccess', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it('offers what the Hub says this person may do to a custom app', async () => {
    apiFetch.mockResolvedValue(answer(200, { actions: ['view', 'start', 'stop', 'restart'] }));

    const { result } = renderHook(() => useCustomAppAccess(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.actions).toEqual(['view', 'start', 'stop', 'restart']));
    expect(apiFetch).toHaveBeenCalledWith('/api/custom-apps/access');
    expect(result.current.may('start')).toBe(true);
    expect(result.current.may('configure')).toBe(false);
  });

  // While the answer is on its way, and when it fails, nothing that changes the app is offered.
  it('offers nothing while it waits, or when the Hub does not answer', async () => {
    apiFetch.mockResolvedValue(answer(503, { message: 'unavailable' }));

    const { result } = renderHook(() => useCustomAppAccess(), { wrapper: wrapper() });

    expect(result.current.actions).toEqual([]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current.may('install')).toBe(false);
  });
});
