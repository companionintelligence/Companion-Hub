import { infiniteQueryOptions } from '@tanstack/react-query';
import { searchAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { searchApps, type Options } from '@/api-client/sdk.gen';
import type { SearchAppsData } from '@/api-client/types.gen';

type MarketplaceSearchQuery = {
  search?: string;
  category?: string;
  pageSize?: number;
  storeId?: string;
  cursor?: string | null;
};

type SearchAppsPage = {
  data?: Array<{ id: string; available?: boolean; [key: string]: unknown }>;
  nextCursor?: string | null;
  total?: number;
};

export const searchAppsInfiniteOptions = (options?: Options<SearchAppsData> & { query?: MarketplaceSearchQuery }) => {
  return infiniteQueryOptions({
    queryKey: searchAppsQueryKey(options),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SearchAppsPage) => lastPage.nextCursor ?? undefined,
    queryFn: async ({ pageParam, queryKey, signal }) => {
      const key = queryKey[0] as { query?: MarketplaceSearchQuery };
      const { data } = await searchApps({
        ...options,
        ...key,
        query: {
          ...options?.query,
          ...key.query,
          cursor: pageParam ?? undefined,
        },
        signal,
        throwOnError: true,
      } as Options<SearchAppsData>);
      return data as SearchAppsPage;
    },
  });
};
