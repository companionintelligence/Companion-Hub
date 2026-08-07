import { getEnabledAppStoresOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { searchAppsInfiniteOptions } from '@/lib/marketplace-search-query';
import { applyStoreBrowseParams, parseStoreBrowseParams } from '@/lib/store-browse-params';
import { invalidateStoreCatalogQueries } from '@/lib/invalidate-store-catalog-queries';
import { pullAppStores } from '@/api-client/sdk.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { usePortalCatalog } from '@/lib/hooks/use-portal-catalog';
import { FeaturedStoreView } from '@/modules/app/components/featured-store-view/featured-store-view';
import { AppStoreSearchInput } from '@/modules/app/components/app-store-search-input/app-store-search-input';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { AppCard } from '@/modules/app/components/app-card/app-card';
import { getCategoryLabel } from '@/modules/app/helpers/category-label';
import { iconForCategory, colorSchemeForCategory } from '@/modules/app/helpers/table-helpers';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, ArrowLeftRight, LayoutGrid, Loader2, RefreshCw, Store } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Navigate, useParams, Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

interface AltEntry {
  name: string;
  icon: string | null;
  url: string | null;
  appSlug?: string;
}

interface AltItem {
  proprietary: AltEntry[];
  alternatives: AltEntry[];
}

const SKELETONS = Array.from({ length: 12 }, (_, i) => `skeleton-${i}`);
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
  const catalogSearchQuery = useMemo(() => ({ search, category: effectiveCategory, pageSize: 24, storeId }), [search, effectiveCategory, storeId]);
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
    onSuccess: () => {
      invalidateStoreCatalogQueries(queryClient);
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
  } = usePortalCatalog({}, { enableConfig: false, enableListings: false, enableAlternatives: isAlternativesView });

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

  const { data: installedAppsData } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const installedAppUrns = useMemo(() => {
    if (!installedAppsData?.installed) return new Set<string>();
    return new Set(installedAppsData.installed.map((a) => a.info.urn));
  }, [installedAppsData]);

  const ciCloudStore = appStores?.appStores?.find((s) => s.slug === 'ci-marketplace' || s.name === 'CI Marketplace');
  const marketplaceSlug = ciCloudStore?.slug ?? storeId ?? 'ci-marketplace';

  // Portal links any alternative with a curated `appSlug`. Catalog listings stay visible
  // across architectures; install is gated on the app detail page when the Hub arch
  // is unsupported. Trust Portal's slug for alternative links.
  const isAlternativeInStore = useCallback((alt: AltEntry) => Boolean(alt.appSlug), []);

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

  const { lastElementRef } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage: Boolean(hasNextPage),
    isFetching: isFetchingNextPage || isFetching,
  });

  // Filter alternatives by search query (source: portal `/api/store/alternatives`)
  const filteredAlts = useMemo(() => {
    const alts = alternativesData ?? {};
    if (!search) return alts;
    const q = search.toLowerCase();
    const result: Record<string, AltItem[]> = {};
    for (const [cat, items] of Object.entries(alts)) {
      const filtered = (items as AltItem[]).filter((item) => {
        const propMatch = item.proprietary.some((p) => p.name.toLowerCase().includes(q));
        const altMatch = item.alternatives.some((a) => a.name.toLowerCase().includes(q));
        const catMatch = cat.toLowerCase().includes(q);
        return propMatch || altMatch || catMatch;
      });
      if (filtered.length > 0) {
        result[cat] = filtered;
      }
    }
    return result;
  }, [search, alternativesData]);

  if (params.storeId) {
    return <Navigate to={`/store?store=${params.storeId}`} />;
  }

  if (isCheckingRegistration || (registrationStatus && !registrationStatus.registered)) {
    return <AppStorePageSuspense />;
  }

  if (isLoading) {
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
          {!isAlternativesDataLoading && !isAlternativesDataError && Object.keys(filteredAlts).length === 0 ? (
            <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
          ) : !isAlternativesDataLoading && !isAlternativesDataError ? (
            Object.entries(filteredAlts).map(([altCategory, items]) => {
              const categoryInfo = iconForCategory.find((c) => c.id === altCategory);
              const Icon = categoryInfo?.icon;
              const color = colorSchemeForCategory[altCategory] || 'blue';

              return (
                <Card key={altCategory} className="overflow-hidden">
                  <CardHeader className="border-b bg-muted/30 px-3 py-3 sm:px-6 sm:py-4">
                    <div className="flex items-center gap-2">
                      {Icon && <Icon className={clsx('h-5 w-5', `text-${color}`)} />}
                      <CardTitle className="capitalize text-base">{altCategory}</CardTitle>
                    </div>
                  </CardHeader>
                  {/* The tighter mobile cell padding is part of the arrow fix, not cosmetics: with the
                      default `p-4` this table's min-content still exceeded the card at 360px, so an
                      un-crushable arrow simply moved off the right edge of the scroller instead of
                      disappearing inside the pill. `px-2` buys back the 32px that makes it fit. */}
                  <div className="w-full overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/20 hover:bg-muted/20">
                          <TableHead className="w-1/2 px-2 font-semibold sm:px-4">{t('APP_STORE_PROPRIETARY')}</TableHead>
                          <TableHead className="w-1/2 px-2 font-semibold sm:px-4">{t('APP_STORE_OPEN_SOURCE_ALTERNATIVES')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(items as AltItem[]).map((item, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: Static list
                          <TableRow key={index}>
                            <TableCell className="px-2 py-3 sm:px-4">
                              <div className="flex flex-wrap gap-2">
                                {item.proprietary.map((prop) => (
                                  <div
                                    key={prop.name}
                                    className="flex items-center gap-2 rounded-full bg-muted/50 px-3 py-1.5 text-sm"
                                    title={prop.name}
                                  >
                                    {prop.icon && (
                                      <img src={prop.icon} alt={prop.name} className="h-5 w-5 rounded-full object-cover" loading="lazy" />
                                    )}
                                    <span className="font-medium">{prop.name}</span>
                                  </div>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="px-2 py-3 sm:px-4">
                              <div className="flex flex-wrap gap-2">
                                {item.alternatives.map((alt) => {
                                  const isInStore = isAlternativeInStore(alt);
                                  if (isInStore) {
                                    return (
                                      <Link
                                        key={alt.name}
                                        to={`/store/${marketplaceSlug}/${alt.appSlug}`}
                                        className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
                                      >
                                        {alt.icon && (
                                          <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover" loading="lazy" />
                                        )}
                                        {alt.name}
                                        {/* `shrink-0` is load-bearing: an <svg> carries UA `overflow: hidden`, so its
                                            `min-width: auto` resolves to 0 (CSS Flexbox 4.5) and the arrow is the one
                                            child of this pill that flex can crush to nothing. At 360px it did exactly
                                            that — 55 of 113 arrows, some to 0px — while the sibling <img> and "Soon"
                                            <span> kept their size, because `overflow: visible` earns them a
                                            content-based minimum. */}
                                        <ArrowRight className="h-3 w-3 shrink-0" />
                                      </Link>
                                    );
                                  }
                                  return (
                                    <div
                                      key={alt.name}
                                      className="flex cursor-not-allowed items-center gap-2 rounded-full bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground"
                                    >
                                      {alt.icon && (
                                        <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover grayscale" loading="lazy" />
                                      )}
                                      {alt.name}
                                      <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-xs">{t('ONBOARDING_SOON')}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              );
            })
          ) : null}
        </div>
      ) : !apps?.length && !isLoading ? (
        <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
      ) : (
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
      )}
    </div>
  );
};
