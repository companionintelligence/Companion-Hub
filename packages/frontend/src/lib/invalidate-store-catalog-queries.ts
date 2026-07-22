import type { QueryClient } from '@tanstack/react-query';

/** Invalidate Hub + Portal catalog queries after a marketplace pull/sync. */
export function invalidateStoreCatalogQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      if (typeof key === 'object' && key !== null && '_id' in key) {
        const id = (key as { _id?: string })._id;
        return id === 'searchApps' || id === 'getEnabledAppStores' || id === 'getInstalledApps' || id === 'getAllAppStores';
      }
      return key === 'portal';
    },
  });
}
