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
import { useAppContext } from '@/context/app-context';
import { AppCard } from '@/modules/app/components/app-card/app-card';
import { getCategoryLabel } from '@/modules/app/helpers/category-label';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { filterAlternativesBySearch } from '@/lib/store-search';
import type { HubStoreApp, HubStoreChangelogEntry, HubStoreLibrary } from '@/lib/portal-store';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, BookOpen, LayoutGrid, Library, Loader2, RefreshCw, Rss, Store } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

const SKELETONS = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => `skeleton-${i}`);
const MARKETPLACE_SEARCH_STALE_MS = 5 * 60_000;
const CHANGELOG_SKELETONS = ['changelog-skeleton-1', 'changelog-skeleton-2', 'changelog-skeleton-3'];

const ALTERNATIVES_VIEW = '__alternatives__';
const CHANGELOG_VIEW = '__changelog__';
const LIBRARY_VIEW = '__library__';
const DEFAULT_STORE_CATEGORY = 'featured';

function formatActivityDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

function StoreChangelogView({
  items,
  isLoading,
  isError,
  onRetry,
}: {
  items: HubStoreChangelogEntry[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="space-y-4 pb-8">
      <div>
        <h2 className="text-2xl font-semibold">What's New</h2>
        <p className="text-sm text-muted-foreground">Recent app releases and updates from CI-Portal.</p>
      </div>
      {isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {CHANGELOG_SKELETONS.map((key) => (
            <div key={key} className="h-20 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Couldn't load What's New.{' '}
          <button type="button" className="font-medium underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">No recent app activity.</p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-card/50">
          {items.map((item) => (
            <Link
              key={item.id}
              to={`/store/ci-marketplace/${item.id}`}
              className="flex items-start gap-4 p-4 transition-colors hover:bg-muted/30 sm:p-5"
            >
              {item.icon ? (
                <img src={item.icon} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" loading="lazy" />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-lg font-semibold text-primary">
                  {item.title.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h3 className="font-semibold text-foreground">{item.title}</h3>
                  {item.version && <span className="text-xs text-muted-foreground">v{item.version}</span>}
                  <span className="text-xs text-muted-foreground">{formatActivityDate(item.activityAt)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
              </div>
              <BookOpen className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function OrganizationLibraryView({
  library,
  catalogApps,
  organizationName,
  installedAppUrns,
  isLoading,
  isError,
  onRetry,
}: {
  library: HubStoreLibrary | undefined;
  catalogApps: Map<string, HubStoreApp>;
  organizationName?: string;
  installedAppUrns: Set<string>;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const entitlements = library?.entitlements ?? [];
  const title = organizationName ? `${organizationName} Library` : 'Organization Library';

  return (
    <section className="space-y-4 pb-8">
      <div>
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">Apps this organization is entitled to run.</p>
      </div>
      {isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-muted/40" aria-busy="true" />
      ) : isError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Couldn't load this organization's library.{' '}
          <button type="button" className="font-medium underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : library?.organizationId ? (
        entitlements.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-card/50 p-8 text-center">
            <p className="font-medium">This organization has no paid or granted apps yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">Free apps can be installed from the store.</p>
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entitlements.map((entitlement) => {
              const app = catalogApps.get(entitlement.appId);
              if (app) {
                return <AppCard key={entitlement.appId} app={app} isInstalled={installedAppUrns.has(app.urn)} />;
              }

              return (
                <div
                  key={entitlement.appId}
                  className="flex min-h-36 items-center justify-between gap-4 rounded-lg border border-border/60 bg-card/50 p-4"
                >
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{entitlement.appId}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">Available to this organization</p>
                  </div>
                  <Link to={`/store/ci-marketplace/${entitlement.appId}`} className="shrink-0 text-sm font-medium text-primary hover:underline">
                    View
                  </Link>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <div className="rounded-lg border border-border/60 bg-card/50 p-8 text-center">
          <Library className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No organization is connected to this Hub yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">Pair this Hub with an organization to see its app entitlements.</p>
        </div>
      )}
    </section>
  );
}

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
  const { userSettings } = useAppContext();
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
  const isChangelogView = category === CHANGELOG_VIEW;
  const isLibraryView = category === LIBRARY_VIEW;
  const effectiveCategory = isAlternativesView || isFeaturedView || isChangelogView || isLibraryView ? undefined : category;
  const catalogSearchQuery = useMemo(
    () => ({ search, category: effectiveCategory, pageSize: CATALOG_PAGE_SIZE, storeId }),
    [search, effectiveCategory, storeId],
  );
  const catalogSearchEnabled = !isAlternativesView && !isFeaturedView && !isChangelogView && !isLibraryView;

  const changelogQuery = useQuery({
    queryKey: ['portal', 'store-changelog'],
    queryFn: async () => {
      const response = await apiFetch('/api/store/changelog');
      if (!response.ok) throw new Error(`CI-Portal returned HTTP ${response.status} for the changelog.`);
      return (await response.json()) as { items: HubStoreChangelogEntry[] };
    },
    enabled: isChangelogView,
    staleTime: 5 * 60_000,
  });

  const libraryQuery = useQuery({
    queryKey: ['portal', 'store-library'],
    queryFn: async () => {
      const response = await apiFetch('/api/store/library');
      if (!response.ok) throw new Error(`CI-Portal returned HTTP ${response.status} for the library.`);
      return (await response.json()) as HubStoreLibrary;
    },
    enabled: isLibraryView,
    staleTime: 60_000,
  });

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
    listings: portalListings,
    hasListingsData,
    alternatives: alternativesData,
    isLoading: isPortalCatalogLoading,
    alternativesError: alternativesDataError,
    listingsError: portalListingsError,
    refetchAlternatives,
  } = usePortalCatalog(
    {},
    {
      enableConfig: false,
      enableListings: true,
      enableAlternatives: isAlternativesView || Boolean(search.trim()),
    },
  );
  const isAlternativesDataLoading = isPortalCatalogLoading;
  const isAlternativesDataError = Boolean(alternativesDataError);
  const trustAppSlugs = !isAlternativesView || (Boolean(portalListingsError) && !hasListingsData);
  const catalogSlugs = useMemo(
    () => new Set((portalListings ?? []).map((app) => app.urn.split(':')[0]).filter((slug): slug is string => Boolean(slug))),
    [portalListings],
  );
  const portalListingsById = useMemo(() => new Map((portalListings ?? []).map((app) => [app.urn.split(':')[0] ?? app.urn, app])), [portalListings]);

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
      if ((category === 'featured' || category === CHANGELOG_VIEW || category === LIBRARY_VIEW) && value.trim().length > 0) {
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
  const showSearchAlternatives =
    Boolean(search.trim()) && !isFeaturedView && !isAlternativesView && !isChangelogView && !isLibraryView && hasAlternativeMatches;

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
      <div
        className={clsx('mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', (isChangelogView || isLibraryView) && 'hidden')}
      >
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
          <Button
            variant="outline"
            size="sm"
            className={clsx(
              'rounded-full whitespace-nowrap',
              isChangelogView ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border',
            )}
            onClick={() => setCategory(CHANGELOG_VIEW)}
          >
            <Rss className="mr-1.5 h-3.5 w-3.5" />
            What's New
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={clsx(
              'rounded-full whitespace-nowrap',
              isLibraryView ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border',
            )}
            onClick={() => setCategory(LIBRARY_VIEW)}
          >
            <Library className="mr-1.5 h-3.5 w-3.5" />
            Library
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
      ) : isChangelogView ? (
        <StoreChangelogView
          items={changelogQuery.data?.items ?? []}
          isLoading={changelogQuery.isLoading}
          isError={changelogQuery.isError}
          onRetry={() => void changelogQuery.refetch()}
        />
      ) : isLibraryView ? (
        <OrganizationLibraryView
          library={libraryQuery.data}
          catalogApps={portalListingsById}
          organizationName={userSettings.ciHubOrganizationLabel}
          installedAppUrns={installedAppUrns}
          isLoading={libraryQuery.isLoading}
          isError={libraryQuery.isError}
          onRetry={() => void libraryQuery.refetch()}
        />
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
          {!isAlternativesDataLoading && !isAlternativesDataError ? (
            <AlternativesCatalog
              alternatives={alternativesData ?? {}}
              marketplaceSlug={marketplaceSlug}
              query={search}
              catalogSlugs={catalogSlugs}
              trustAppSlugs={trustAppSlugs}
            />
          ) : null}
        </div>
      ) : !apps?.length && !isLoading && !showSearchAlternatives ? (
        <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
      ) : (
        <div className="space-y-8">
          {showSearchAlternatives && !isAlternativesDataLoading ? (
            <AlternativesCatalog
              alternatives={alternativesData ?? {}}
              marketplaceSlug={marketplaceSlug}
              title={t('APP_STORE_ALTERNATIVES')}
              subtitle={t('APP_STORE_ALTERNATIVES_SUBTITLE')}
              query={search}
              catalogSlugs={catalogSlugs}
              trustAppSlugs={trustAppSlugs}
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
                    const slug = app.urn.split(':')[0] ?? app.urn;
                    const portalApp = marketplaceSlug === 'ci-marketplace' ? portalListingsById.get(slug) : undefined;
                    return (
                      <div ref={isLastElement ? lastElementRef : null} key={app.urn}>
                        <AppCard
                          app={
                            portalApp
                              ? {
                                  ...app,
                                  name: portalApp.name,
                                  short_desc: portalApp.short_desc,
                                  icon: portalApp.iconUrl,
                                  priceModel: portalApp.priceModel,
                                  price: portalApp.price,
                                  rating: portalApp.rating,
                                  supported_architectures: portalApp.supported_architectures,
                                  host_access: portalApp.host_access,
                                  gpu_requirements: portalApp.gpu_requirements,
                                }
                              : app
                          }
                          imageUrlOverride={portalApp?.iconUrl}
                          isLoading={false}
                          isInstalled={installedAppUrns.has(app.urn)}
                        />
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
