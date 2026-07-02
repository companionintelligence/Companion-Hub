import { searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const CATALOG_STALE_MS = 5 * 60_000;
const EMPTY_CATALOG_REFETCH_MS = 3_000;
const EMPTY_CATALOG_MAX_REFETCHES = 5;

/** On-demand marketplace catalog for onboarding — avoids loading the full catalog via app-context. */
export function useMarketplaceCatalogApps() {
  const queryOptions = searchAppsOptions({ query: { pageSize: 500 } });
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<{ data?: unknown[] }>(queryOptions.queryKey);
  const cachedHasApps = (cached?.data?.length ?? 0) > 0;

  const { data, isLoading, isFetching, isError, error, refetch, dataUpdatedAt } = useQuery({
    ...queryOptions,
    staleTime: cachedHasApps ? CATALOG_STALE_MS : 0,
    refetchInterval: (query) => {
      if (query.state.status === 'error' || query.state.error) return false;
      const apps = query.state.data?.data ?? [];
      if (apps.length > 0) return false;
      if (query.state.dataUpdateCount >= EMPTY_CATALOG_MAX_REFETCHES) return false;
      return EMPTY_CATALOG_REFETCH_MS;
    },
  });

  const apps = data?.data ?? [];
  const isCatalogSettled = !isLoading && !isFetching;
  const isRetryingEmptyCatalog = !isLoading && isFetching && apps.length === 0;

  return {
    apps,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    isCatalogSettled,
    isRetryingEmptyCatalog,
    dataUpdatedAt,
  };
}
