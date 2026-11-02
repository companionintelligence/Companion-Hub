import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { prefetchOnboardingMarketplace } from './prefetch-onboarding-marketplace';

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({ searchAppsOptions: () => ({ queryKey: ['search-apps'] }) }));
vi.mock('@/lib/portal-alternatives', () => ({ portalAlternativesQueryOptions: () => ({ queryKey: ['alternatives'] }) }));
vi.mock('@/lib/portal-store', () => ({ portalStoreListingsQueryOptions: () => ({ queryKey: ['listings'] }) }));

describe('prefetchOnboardingMarketplace', () => {
  it('warms all three catalogs', async () => {
    const ensureQueryData = vi.fn().mockResolvedValue(undefined);

    await prefetchOnboardingMarketplace({ ensureQueryData } as unknown as QueryClient);

    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([['search-apps'], ['alternatives'], ['listings']]);
  });

  it('settles when the Hub cannot be reached, so the warm-up never ends as an unhandled rejection', async () => {
    const ensureQueryData = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(prefetchOnboardingMarketplace({ ensureQueryData } as unknown as QueryClient)).resolves.toBeUndefined();
    expect(ensureQueryData).toHaveBeenCalledTimes(3);
  });
});
