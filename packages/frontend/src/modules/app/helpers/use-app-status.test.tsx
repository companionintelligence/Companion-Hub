import { getAppQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useAppStatus } from './use-app-status';

const URN = 'comfyui:ci-marketplace';

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useAppStatus.setOptimisticStatus', () => {
  // Regression test: installing an app straight from a store listing (never having visited its
  // detail page, so getApp's query cache has no entry yet) crashed the whole frontend with
  // "Cannot read properties of undefined (reading 'app')" — Immer's produce(undefined, recipe)
  // hands the recipe an undefined draft, and `if (!draft.app)` reads a property off it.
  it('does not throw when there is no cached entry for the app', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useAppStatus(), { wrapper: wrapper(queryClient) });

    expect(() => {
      act(() => {
        result.current.setOptimisticStatus('installing', URN);
      });
    }).not.toThrow();

    // Nothing to patch — the cache stays empty until the real query fetches it.
    expect(queryClient.getQueryData(getAppQueryKey({ path: { urn: URN } }))).toBeUndefined();
  });

  it('sets app on a cached entry that has none yet', () => {
    const queryClient = new QueryClient();
    const queryKey = getAppQueryKey({ path: { urn: URN } });
    queryClient.setQueryData(queryKey, { app: null, info: { id: 'comfyui' } });

    const { result } = renderHook(() => useAppStatus(), { wrapper: wrapper(queryClient) });

    act(() => {
      result.current.setOptimisticStatus('installing', URN);
    });

    const data = queryClient.getQueryData(queryKey) as any;
    expect(data.app).toMatchObject({ id: 'comfyui', urn: URN, status: 'installing' });
  });

  it('updates status on an existing cached app', () => {
    const queryClient = new QueryClient();
    const queryKey = getAppQueryKey({ path: { urn: URN } });
    queryClient.setQueryData(queryKey, { app: { id: 'comfyui', urn: URN, status: 'stopped' }, info: { id: 'comfyui' } });

    const { result } = renderHook(() => useAppStatus(), { wrapper: wrapper(queryClient) });

    act(() => {
      result.current.setOptimisticStatus('starting', URN);
    });

    const data = queryClient.getQueryData(queryKey) as any;
    expect(data.app.status).toBe('starting');
  });

  it('does not throw and logs for an invalid app urn', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useAppStatus(), { wrapper: wrapper(queryClient) });

    expect(() => {
      act(() => {
        result.current.setOptimisticStatus('installing', 'no-colon-here');
      });
    }).not.toThrow();
  });
});
