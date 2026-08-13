import { getStoreFeaturedBundle } from '@/api-client/sdk.gen';
import { normalizeStoreListingsPayload, type HubStoreApp, CI_MARKETPLACE_STORE_ID, mapPortalStoreAppToHub } from '@/lib/portal-store';
import { queryOptions } from '@tanstack/react-query';

export type FeaturedStoreBundle = {
  firstParty: HubStoreApp[];
  featured: HubStoreApp[];
  trending: HubStoreApp[];
  newest: HubStoreApp[];
};

function remapStore(apps: HubStoreApp[], storeId: string): HubStoreApp[] {
  if (storeId === CI_MARKETPLACE_STORE_ID) return apps;
  return apps.map((app) => {
    const slug = app.urn.split(':')[0] ?? app.urn;
    return mapPortalStoreAppToHub({ id: slug, name: app.name, short_desc: app.short_desc, categories: app.categories, icon: app.iconUrl }, storeId);
  });
}

export const getFeaturedStoreBundleQueryKey = (storeId = CI_MARKETPLACE_STORE_ID) => ['portal', 'featured-bundle', storeId] as const;

export const getFeaturedStoreBundleOptions = (storeId = CI_MARKETPLACE_STORE_ID) => {
  return queryOptions({
    queryKey: getFeaturedStoreBundleQueryKey(storeId),
    queryFn: async ({ signal }): Promise<FeaturedStoreBundle> => {
      const { data, error } = await getStoreFeaturedBundle({ signal });
      if (error) {
        throw error;
      }
      const payload = data ?? { firstParty: [], featured: [], trending: [], newest: [] };
      return {
        firstParty: remapStore(normalizeStoreListingsPayload(payload.firstParty), storeId),
        featured: remapStore(normalizeStoreListingsPayload(payload.featured), storeId),
        trending: remapStore(normalizeStoreListingsPayload(payload.trending), storeId),
        newest: remapStore(normalizeStoreListingsPayload(payload.newest), storeId),
      };
    },
    staleTime: 5 * 60 * 1000,
  });
};
