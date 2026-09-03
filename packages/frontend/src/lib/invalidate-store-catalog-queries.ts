import type { QueryClient } from '@tanstack/react-query';

const CATALOG_QUERY_IDS = new Set([
  'searchApps',
  'getEnabledAppStores',
  'getInstalledApps',
  'getAllAppStores',
  'getApp',
  'getStoreListings',
  'getStoreFeaturedBundle',
]);

export function isStoreCatalogQueryKey(queryKey: readonly unknown[]): boolean {
  const key = queryKey[0];
  if (typeof key === 'object' && key !== null && '_id' in key) {
    return CATALOG_QUERY_IDS.has((key as { _id?: string })._id ?? '');
  }
  return key === 'portal';
}

/** Invalidate Hub + Portal catalog queries after a marketplace pull/sync. */
export async function invalidateStoreCatalogQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({
    predicate: (query) => isStoreCatalogQueryKey(query.queryKey),
  });
}
