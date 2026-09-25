import { getEnabledAppStoresOptions } from '@/api-client/@tanstack/react-query.gen';
import { CATALOG_PAGE_SIZE } from '@/lib/catalog-page-size';
import { searchAppsInfiniteOptions } from '@/lib/marketplace-search-query';
import { getInstalledAppUrnsOptions } from '@/lib/installed-app-urns-query';
import { applyStoreBrowseParams, parseStoreBrowseParams } from '@/lib/store-browse-params';
import { invalidateStoreCatalogQueries } from '@/lib/invalidate-store-catalog-queries';
import { pullAppStores } from '@/api-client/sdk.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { usePortalCatalog } from '@/lib/hooks/use-portal-catalog';
import { FeaturedStoreView } from '@/modules/app/components/featured-store-view/featured-store-view';
import { AlternativesCatalog } from '@/modules/app/components/alternatives-catalog/alternatives-catalog';
import { AppStoreSearchInput } from '@/modules/app/components/app-store-search-input/app-store-search-input';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { AppCard } from '@/modules/app/components/app-card/app-card';
import { getCategoryLabel } from '@/modules/app/helpers/category-label';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { filterAlternativesBySearch } from '@/lib/store-search';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, LayoutGrid, Loader2, RefreshCw, Store } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const SKELETONS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `skeleton-${i}`);
const MARKETPLACE_SEARCH_STALE_MS = 5 * 60_000;

const ALTERNATIVES_VIEW = '__alternatives__';
const DEFAULT_STORE_CATEGORY = 'featured';

export const AppStorePageSuspense = () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0">
        <Card className="action-bar" style={{ height: 60 }} />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Card className="px-3 pb-3" style={{ height: 4000 }} />
      </div>
    </div>
  );
};

export default () => {
  const { t } = useTranslation();
  const params = useParams<{ storeId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setCategory, category, storeId, setStoreId, search, setSearch, setSearchImmediate } = useAppStoreState();
  const [localSearch, setLocalSearch] = useState(search);
  const hasInitializedDefaultCategory = useRef(false);
  const isWritingBrowseUrl = useRef(false);
  const { data: registrationStatus, isLoading: isCheckingRegistration } = useRegistrationStatus();

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  useEffect(() => {
    if (isWritingBrowseUrl.current) {
      isWritingBrowseUrl.current = false;
      return;
    }

    const parsed = parseStoreBrowseParams(searchParams);

    setSearchImmediate(parsed.q ?? '');

    if (parsed.category !== undefined) {
      hasInitializedDefaultCategory.current = true;
      setCategory(parsed.category);
      return;
    }

    if (!hasInitializedDefaultCategory.current) {
      hasInitializedDefaultCategory.current = true;
      setCategory(DEFAULT_STORE_CATEGORY);
    }
  }, [searchParams, setCategory, setSearchImmediate]);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = applyStoreBrowseParams(prev, {
          q: search.trim() ? search : undefined,
          category,
          store: storeId,
        });

        if (next.toString() === prev.toString()) {
          return prev;
        }

        isWritingBrowseUrl.current = true;
        return next;
      },
      { replace: true },
    );
  }, [search, category, storeId, setSearchParams]);

  const queryClient = useQueryClient();

  const isAlternativesView = category === ALTERNATIVES_VIEW;
  const isFeaturedView = category === 'featured';
  const effectiveCategory = isAlternativesView || isFeaturedView ? undefined : category;
  const catalogSearchQuery = useMemo(
    () => ({ search, category: effectiveCategory, pageSize: CATALOG_PAGE_SIZE, storeId }),
    [search, effectiveCategory, storeId],
  );
  const catalogSearchEnabled = !isAlternativesView && !isFeaturedView;

  useEffect(() => {
    if (!catalogSearchEnabled) {
      return;
    }

    void queryClient.prefetchInfiniteQuery({
      ...searchAppsInfiniteOptions({ query: catalogSearchQuery }),
      staleTime: MARKETPLACE_SEARCH_STALE_MS,
    });
  }, [queryClient, catalogSearchEnabled, catalogSearchQuery]);

  const { mutate: pullApps, isPending: isPulling } = useMutation({
    mutationFn: () => pullAppStores(),
    onSuccess: async () => {
      await invalidateStoreCatalogQueries(queryClient);
      toast.success(t('APP_STORES_UPDATE_SUCCESS'));
    },
    onError: () => {
      toast.error(t('APP_STORES_UPDATE_ERROR'));
    },
  });

  const {
    alternatives: alternativesData,
    isLoading: isAlternativesDataLoading,
    isError: isAlternativesDataError,
    alternativesError: alternativesDataError,
    refetchAlternatives,
  } = usePortalCatalog({}, { enableConfig: false, enableListings: false, enableAlternatives: isAlternativesView || Boolean(search.trim()) });

  // Redirect whenever the backend reports the hub is not operational
  // (`registered === false`, e.g. paired/provisioning/unregistered).
  // Fetch errors (status endpoint temporarily unreachable) are NOT treated as
  // unregistered/non-operational — this prevents transient failures from forcing a re-pair flow.
  useEffect(() => {
    if (!isCheckingRegistration && registrationStatus && !registrationStatus.registered) {
      window.location.href = '/device-registration';
    }
  }, [registrationStatus, isCheckingRegistration]);

  const { data: appStores } = useQuery({
    ...getEnabledAppStoresOptions(),
    staleTime: 30_000,
  });

  const { data: installedUrnsData } = useQuery({
    ...getInstalledAppUrnsOptions(),
  });

  const installedAppUrns = useMemo(() => {
    if (!installedUrnsData?.urns) return new Set<string>();
    return new Set(installedUrnsData.urns);
  }, [installedUrnsData]);

  const ciCloudStore = appStores?.appStores?.find((s) => s.slug === 'ci-marketplace' || s.name === 'CI Marketplace');
  const marketplaceSlug = ciCloudStore?.slug ?? storeId ?? 'ci-marketplace';

  // Sync ?store= query param to Zustand, or fall back to first available store
  useEffect(() => {
    const storeParam = searchParams.get('store');
    if (storeParam && appStores?.appStores?.some((s) => s.slug === storeParam)) {
      if (storeId !== storeParam) setStoreId(storeParam);
      return;
    }
    if (appStores?.appStores) {
      let fallbackSlug: string | undefined;
      if (ciCloudStore && storeId !== ciCloudStore.slug) {
        fallbackSlug = ciCloudStore.slug;
      } else if (!ciCloudStore && !storeId && appStores.appStores.length > 0) {
        fallbackSlug = appStores.appStores[0]?.slug;
      }
      if (fallbackSlug) {
        setStoreId(fallbackSlug);
      }
      // Clear invalid ?store= param from URL
      if (storeParam) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('store');
          return next;
        });
      }
    }
  }, [appStores, storeId, setStoreId, ciCloudStore, searchParams, setSearchParams]);

  const handleStoreSwitch = useCallback(
    (slug: string) => {
      setStoreId(slug);
      setSearchParams((prev) => applyStoreBrowseParams(prev, { q: search.trim() ? search : undefined, category, store: slug }), {
        replace: true,
      });
    },
    [setStoreId, setSearchParams, search, category],
  );

  const onSearch = useCallback(
    (value: string) => {
      setLocalSearch(value);
      // Featured is curated; route searching users into the exhaustive "All" query.
      if (category === 'featured' && value.trim().length > 0) {
        setCategory(undefined);
      }
      setSearch(value);
    },
    [category, setCategory, setSearch],
  );

  const { data, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = useInfiniteQuery({
    ...searchAppsInfiniteOptions({ query: catalogSearchQuery }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: MARKETPLACE_SEARCH_STALE_MS,
    enabled: catalogSearchEnabled,
  });

  const isLoading = catalogSearchEnabled && !data;
  const apps = data?.pages.flatMap((page) => page.data) ?? [];

  useEffect(() => {
    if (!catalogSearchEnabled || !hasNextPage || isFetchingNextPage || !data || data.pages.length !== 1) {
      return;
    }

    void fetchNextPage();
  }, [catalogSearchEnabled, data, fetchNextPage, hasNextPage, isFetchingNextPage]);

  const { lastElementRef } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage: Boolean(hasNextPage),
    isFetching: isFetchingNextPage || isFetching,
  });

  const filteredAlts = useMemo(() => filterAlternativesBySearch(alternativesData ?? {}, search), [search, alternativesData]);
  const hasAlternativeMatches = Object.keys(filteredAlts).length > 0;
  const showSearchAlternatives = Boolean(search.trim()) && !isFeaturedView && !isAlternativesView && hasAlternativeMatches;

  if (params.storeId) {
    return <Navigate to={`/store?store=${params.storeId}`} />;
  }

  // Root loader already resolved registration for operational hubs. Only block
  // when we *know* the hub is not registered — not while the status query is
  // still settling (avoids a full-page skeleton on every store revisit).
  if (registrationStatus && !registrationStatus.registered) {
    return <AppStorePageSuspense />;
  }

  return (
    <div className="min-w-0 overflow-x-hidden">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {appStores?.appStores && appStores.appStores.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1" data-testid="store-switcher">
              <Store className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
              {appStores.appStores.map((s) => (
                <Button
                  key={s.slug}
                  variant={storeId === s.slug ? 'default' : 'outline'}
                  size="sm"
                  className="max-w-full rounded-full"
                  onClick={() => handleStoreSwitch(s.slug)}
                >
                  {s.name}
                </Button>
              ))}
            </div>
          ) : appStores?.appStores?.[0] ? (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="store-label">
              <Store className="h-4 w-4" />
              <span>{appStores.appStores[0].name}</span>
            </div>
          ) : null}
        </div>
        <Button onClick={() => pullApps()} disabled={isPulling} variant="outline" size="sm" className="w-full gap-2 sm:w-auto">
          <RefreshCw className={clsx('h-4 w-4', isPulling && 'animate-spin')} />
          {isPulling ? t('APP_STORE_SYNCING') : t('APP_STORE_CHECK_FOR_UPDATES')}
        </Button>
      </div>

      {/* Mobile Search & Categories */}
      <div className="md:hidden space-y-4 mb-6">
        <AppStoreSearchInput value={localSearch} onChange={onSearch} />
        <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar -mx-2 px-2 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
          <Button
            variant="outline"
            size="sm"
            className={clsx(
              'rounded-full whitespace-nowrap',
              category ? 'bg-background text-muted-foreground border-border' : 'bg-primary text-primary-foreground border-primary',
            )}
            onClick={() => setCategory(undefined)}
          >
            <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
            {t('COMMON_ALL')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={clsx(
              'rounded-full whitespace-nowrap',
              isAlternativesView ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border',
            )}
            onClick={() => setCategory(ALTERNATIVES_VIEW)}
          >
            <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" />
            {t('APP_STORE_ALTERNATIVES')}
          </Button>
          {iconForCategory.map((cat) => {
            const Icon = cat.icon;
            const isSelected = category === cat.id;
            return (
              <Button
                key={cat.id}
                variant="outline"
                size="sm"
                className={clsx(
                  'rounded-full whitespace-nowrap',
                  isSelected ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border',
                )}
                onClick={() => setCategory(cat.id)}
              >
                {Icon && <Icon className="h-3.5 w-3.5 mr-1.5" />}
                {getCategoryLabel(t, cat.id)}
              </Button>
            );
          })}
        </div>
      </div>

      {isFeaturedView ? (
        <FeaturedStoreView storeId={ciCloudStore?.slug ?? 'ci-marketplace'} installedAppUrns={installedAppUrns} />
      ) : isAlternativesView ? (
        <div className="min-w-0 space-y-6">
          <div>
            <h2 className="mb-1 text-xl font-semibold text-foreground sm:text-2xl">{t('APP_STORE_ALTERNATIVES')}</h2>
            <p className="text-muted-foreground">{t('APP_STORE_ALTERNATIVES_SUBTITLE')}</p>
          </div>
          {isAlternativesDataLoading && (
            <div className="space-y-4 py-4">
              <div className="h-8 max-w-md w-[60%] animate-pulse rounded bg-muted" />
              <div className="h-40 animate-pulse rounded-md bg-muted/40" />
            </div>
          )}
          {isAlternativesDataError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {t('APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS')}
              {alternativesDataError instanceof Error ? `: ${alternativesDataError.message}` : ''}.{' '}
              <button type="button" className="underline font-medium" onClick={() => refetchAlternatives()}>
                {t('COMMON_RETRY')}
              </button>
            </div>
          )}
          {!isAlternativesDataLoading && !isAlternativesDataError && !hasAlternativeMatches ? (
            <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
          ) : !isAlternativesDataLoading && !isAlternativesDataError ? (
            <AlternativesCatalog alternatives={filteredAlts} marketplaceSlug={marketplaceSlug} />
          ) : null}
        </div>
      ) : !apps?.length && !isLoading && !showSearchAlternatives ? (
        <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
      ) : (
        <div className="space-y-8">
          {showSearchAlternatives ? (
            <AlternativesCatalog
              alternatives={filteredAlts}
              marketplaceSlug={marketplaceSlug}
              title={t('APP_STORE_ALTERNATIVES')}
              subtitle={t('APP_STORE_ALTERNATIVES_SUBTITLE')}
            />
          ) : null}
          {apps.length > 0 || isLoading ? (
            <div className="grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {isLoading && !apps.length
                ? SKELETONS.map((key) => (
                    <AppCard
                      key={key}
                      // biome-ignore lint/suspicious/noExplicitAny: Mock data for skeleton
                      app={{ urn: 'loading:loading', name: '', short_desc: '', categories: [] } as any}
                      isLoading={true}
                    />
                  ))
                : apps.map((app, i) => {
                    const isLastElement = apps.length === i + 1;
                    return (
                      <div ref={isLastElement ? lastElementRef : null} key={app.urn}>
                        <AppCard app={app} isLoading={false} isInstalled={installedAppUrns.has(app.urn)} />
                      </div>
                    );
                  })}
              {isFetchingNextPage && (
                <div className="col-span-full text-center p-4">
                  <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
