import { searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { portalStoreListingsQueryOptions } from '@/lib/portal-store';
import type { QueryClient } from '@tanstack/react-query';

/** Warm marketplace catalog, alternatives, and featured store listings for onboarding and first store visit. */
export async function prefetchOnboardingMarketplace(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.ensureQueryData(searchAppsOptions({ query: { pageSize: 500 } })),
    queryClient.ensureQueryData(portalAlternativesQueryOptions()),
    queryClient.ensureQueryData(portalStoreListingsQueryOptions({ tags: 'featured' })),
  ]);
}
