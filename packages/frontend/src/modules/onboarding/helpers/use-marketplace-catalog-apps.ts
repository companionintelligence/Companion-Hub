import { searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { useQuery } from '@tanstack/react-query';

/** On-demand marketplace catalog for onboarding — avoids loading the full catalog via app-context. */
export function useMarketplaceCatalogApps() {
  const { data, isLoading } = useQuery({
    ...searchAppsOptions({ query: { pageSize: 500 } }),
    staleTime: 5 * 60_000,
  });

  return {
    apps: data?.data ?? [],
    isLoading,
  };
}
