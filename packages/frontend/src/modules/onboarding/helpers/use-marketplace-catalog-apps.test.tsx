import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CATALOG_MAX_REFETCHES, useMarketplaceCatalogApps } from './use-marketplace-catalog-apps';

const h = vi.hoisted(() => ({ queryFn: vi.fn() }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  searchAppsOptions: (options: unknown) => ({
    queryKey: ['searchApps', options],
    queryFn: () => h.queryFn(),
  }),
}));

const APP = { id: 'ci-memory', name: 'Companion Memory', urn: 'ci-memory:ci-marketplace', short_desc: 'Memory' };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Let pending fetches settle and fire any refetch interval that is due. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mount the hook and let the first fetch plus every automatic refetch of an empty catalog run. */
async function exhaustEmptyCatalogRetries() {
  const rendered = renderHook(() => useMarketplaceCatalogApps(), { wrapper: wrapper() });
  await advance(0);
  for (let i = 1; i < EMPTY_CATALOG_MAX_REFETCHES; i++) {
    await advance(3_000);
  }
  return rendered;
}

describe('useMarketplaceCatalogApps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deliver query updates on a microtask so the fake clock does not hold them back.
    notifyManager.setScheduler((callback) => queueMicrotask(callback));
    h.queryFn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps retrying an empty catalog, then reports it unavailable instead of spinning', async () => {
    h.queryFn.mockResolvedValue({ data: [], total: 0, nextCursor: null });
    const { result } = renderHook(() => useMarketplaceCatalogApps(), { wrapper: wrapper() });

    await advance(0);
    expect(result.current.apps).toEqual([]);
    expect(result.current.isCatalogUnavailable).toBe(false);

    for (let i = 1; i < EMPTY_CATALOG_MAX_REFETCHES; i++) {
      await advance(3_000);
    }

    expect(h.queryFn).toHaveBeenCalledTimes(EMPTY_CATALOG_MAX_REFETCHES);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.isRetryingEmptyCatalog).toBe(false);
    expect(result.current.isCatalogUnavailable).toBe(true);

    // The automatic retries are over; nothing polls behind the Retry control.
    await advance(30_000);
    expect(h.queryFn).toHaveBeenCalledTimes(EMPTY_CATALOG_MAX_REFETCHES);
    expect(result.current.isCatalogUnavailable).toBe(true);
  });

  it('clears the unavailable state once a manual retry returns apps', async () => {
    h.queryFn.mockResolvedValue({ data: [], total: 0, nextCursor: null });
    const { result } = await exhaustEmptyCatalogRetries();
    expect(result.current.isCatalogUnavailable).toBe(true);

    h.queryFn.mockResolvedValue({ data: [APP], total: 1, nextCursor: null });
    await act(async () => {
      await result.current.refetch();
    });
    await advance(0);

    expect(result.current.apps).toEqual([APP]);
    expect(result.current.isCatalogUnavailable).toBe(false);
  });

  it('never reports a catalog with apps as unavailable', async () => {
    h.queryFn.mockResolvedValue({ data: [APP], total: 1, nextCursor: null });
    const { result } = renderHook(() => useMarketplaceCatalogApps(), { wrapper: wrapper() });

    await advance(0);
    await advance(30_000);

    expect(result.current.apps).toEqual([APP]);
    expect(result.current.isCatalogUnavailable).toBe(false);
    expect(h.queryFn).toHaveBeenCalledTimes(1);
  });
});
