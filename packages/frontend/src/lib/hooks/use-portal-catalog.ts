import { useQuery } from '@tanstack/react-query';
import { portalAlternativesQueryOptions } from '@/lib/portal-alternatives';
import { portalStoreListingsQueryOptions, type PortalStoreListingsParams } from '@/lib/portal-store';
import { portalConfigQueryOptions } from '@/lib/portal-config';

type PortalCatalogOptions = {
  enableConfig?: boolean;
  enableListings?: boolean;
  enableAlternatives?: boolean;
};

/** Hub-proxied Portal catalog — listings, alternatives, and config in one hook. */
export function usePortalCatalog(listingsParams: PortalStoreListingsParams = {}, options: PortalCatalogOptions = {}) {
  const enableConfig = options.enableConfig ?? true;
  const enableListings = options.enableListings ?? true;
  const enableAlternatives = options.enableAlternatives ?? true;

  const configQuery = useQuery({ ...portalConfigQueryOptions(), enabled: enableConfig });
  const listingsQuery = useQuery({ ...portalStoreListingsQueryOptions(listingsParams), enabled: enableListings });
  const alternativesQuery = useQuery({ ...portalAlternativesQueryOptions(), enabled: enableAlternatives });

  return {
    portalConfig: configQuery.data,
    listings: listingsQuery.data ?? [],
    alternatives: alternativesQuery.data ?? {},
    isLoading:
      (enableConfig && configQuery.isLoading) || (enableListings && listingsQuery.isLoading) || (enableAlternatives && alternativesQuery.isLoading),
    isError: (enableConfig && configQuery.isError) || (enableListings && listingsQuery.isError) || (enableAlternatives && alternativesQuery.isError),
    alternativesError: enableAlternatives ? alternativesQuery.error : undefined,
    listingsError: enableListings ? listingsQuery.error : undefined,
    refetchListings: listingsQuery.refetch,
    refetchAlternatives: alternativesQuery.refetch,
  };
}
