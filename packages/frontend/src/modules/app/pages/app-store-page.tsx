import { getEnabledAppStoresOptions, searchAppsInfiniteOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery, useQuery } from '@tanstack/react-query';
import { StoreTile } from '@/modules/app/components/store-tile/store-tile';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { Input } from '@/components/ui/Input';
import { useTranslation } from 'react-i18next';
import { CategorySelector } from '@/components/category-selector/category-selector';
import { ActionBar } from '@/components/action-bar/action-bar';
import { Navigate, useParams, useSearchParams, Link } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs/tabs';
import alts from '@/lib/data/alts.json';
import { iconForCategory, colorSchemeForCategory } from '@/modules/app/helpers/table-helpers';
import clsx from 'clsx';

export const AppStorePageSuspense = () => {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0">
        <div className="card action-bar" style={{ height: 60 }} />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="card px-3 pb-3" style={{ height: 4000 }} />
      </div>
    </div>
  );
};

export default () => {
  const params = useParams<{ storeId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedStore = searchParams.get('store') ?? undefined;
  const activeTab = searchParams.get('tab') || 'alternatives';

  const { setCategory, category, storeId, setStoreId, search: initialSearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(initialSearch);
  const { t } = useTranslation();
  const { data: registrationStatus, isLoading: isCheckingRegistration, error: registrationError } = useRegistrationStatus();

  // Redirect to device registration if not registered or if API returns forbidden
  useEffect(() => {
    if (!isCheckingRegistration) {
      if (registrationError || (registrationStatus && !registrationStatus.registered)) {
        window.location.href = '/device-registration';
      }
    }
  }, [registrationStatus, isCheckingRegistration, registrationError]);

  useEffect(() => {
    if (selectedStore !== undefined && selectedStore !== storeId) {
      setStoreId(selectedStore);
    }
  }, [selectedStore, setStoreId, storeId]);

  const { data: appStores } = useSuspenseQuery({
    ...getEnabledAppStoresOptions(),
  });

  const ciCloudStore = appStores?.appStores?.find((s) => s.name === 'CI Cloud');

  const { data: allAppsData } = useQuery({
    ...searchAppsOptions({
      query: { pageSize: 1000, storeId: ciCloudStore?.slug },
    }),
    enabled: !!ciCloudStore && activeTab === 'alternatives',
  });

  const availableAppSlugs = useMemo(() => {
    if (!allAppsData?.data) return new Set<string>();
    return new Set(allAppsData.data.filter((app) => app.available).map((app) => app.id));
  }, [allAppsData]);

  // Ensure "CI Cloud" is selected or fallback to default
  useEffect(() => {
    // If a specific store is selected in URL, do not override it with defaults
    if (selectedStore) return;

    if (appStores?.appStores) {
      // Find CI Cloud store
      if (ciCloudStore && storeId !== ciCloudStore.slug) {
        setStoreId(ciCloudStore.slug);
      } else if (!ciCloudStore && !storeId && appStores.appStores.length > 0) {
        setStoreId(appStores.appStores[0]?.slug);
      }
    }
  }, [appStores, storeId, setStoreId, selectedStore, ciCloudStore]);

  const onSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalSearch(e.target.value);
      setSearch(e.target.value);
    },
    [setSearch],
  );

  const onTabChange = useCallback(
    (tab: string) => {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev);
          newParams.set('tab', tab);
          return newParams;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const { data, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = useInfiniteQuery({
    ...searchAppsInfiniteOptions({ query: { search, category, pageSize: 24, storeId } }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
  });

  const isLoading = !data;
  const apps = data?.pages.flatMap((page) => page.data) ?? [];

  const { lastElementRef } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage: Boolean(hasNextPage),
    isFetching: isFetchingNextPage || isFetching,
  });

  if (params.storeId) {
    return <Navigate to={`/app-store?store=${params.storeId}`} />;
  }

  // Show loading while checking registration or if not registered
  if (isCheckingRegistration || (registrationStatus && !registrationStatus.registered)) {
    return <AppStorePageSuspense />;
  }

  if (isLoading) {
    return <AppStorePageSuspense />;
  }

  return (
    <div className="h-full flex flex-col p-4">
      <Tabs value={activeTab} onValueChange={onTabChange} className="h-full flex flex-col">
        <div className="flex-shrink-0 mb-4">
          <TabsList>
            <TabsTrigger value="alternatives">Alternatives</TabsTrigger>
            <TabsTrigger value="browse">Browse</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="alternatives" className="flex-1 overflow-y-auto min-h-0 card p-4">
          {Object.entries(alts).map(([category, items]) => {
            const categoryInfo = iconForCategory.find((c) => c.id === category);
            const Icon = categoryInfo?.icon;
            const color = colorSchemeForCategory[category] || 'blue';

            return (
              <div key={category} className="card mb-4">
                <div className="card-header">
                  <div className="d-flex align-items-center">
                    {Icon && <Icon className={clsx('icon me-2', `text-${color}`)} />}
                    <h3 className="card-title text-capitalize">{category}</h3>
                  </div>
                </div>
                <div className="table-responsive">
                  <table className="table table-vcenter card-table">
                    <thead>
                      <tr>
                        <th className="w-50">Proprietary</th>
                        <th className="w-50">Open Source Alternatives</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* biome-ignore lint/suspicious/noExplicitAny: JSON import typing */}
                      {(items as any[]).map((item, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Static list
                        <tr key={index}>
                          <td>
                            <div className="flex flex-wrap gap-2">
                              {/* biome-ignore lint/suspicious/noExplicitAny: JSON import typing */}
                              {(item.proprietary as any[]).map((prop) => (
                                <div key={prop.name} className="d-flex align-items-center me-3 mb-2" title={prop.name}>
                                  {prop.icon && <span className="avatar avatar-sm me-2" style={{ backgroundImage: `url(${prop.icon})` }} />}
                                  <span>{prop.name}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-2">
                              {/* biome-ignore lint/suspicious/noExplicitAny: JSON import typing */}
                              {(item.alternatives as any[]).map((alt) => {
                                const isAvailable = alt.appSlug && availableAppSlugs.has(alt.appSlug) && ciCloudStore;
                                if (isAvailable) {
                                  return (
                                    <Link
                                      key={alt.name}
                                      to={`/app-store/${ciCloudStore.slug}/${alt.appSlug}`}
                                      className="btn btn-ghost-primary d-flex align-items-center me-2 mb-2"
                                    >
                                      {alt.icon && <span className="avatar avatar-xs me-2" style={{ backgroundImage: `url(${alt.icon})` }} />}
                                      {alt.name}
                                    </Link>
                                  );
                                }
                                return (
                                  <div
                                    key={alt.name}
                                    className="btn btn-ghost-secondary d-flex align-items-center me-2 mb-2 opacity-50 cursor-not-allowed"
                                  >
                                    {alt.icon && (
                                      <span
                                        className="avatar avatar-xs me-2"
                                        style={{ backgroundImage: `url(${alt.icon})`, filter: 'grayscale(100%)' }}
                                      />
                                    )}
                                    {alt.name}
                                    <span className="badge badge-outline text-muted ms-2 text-xs">Soon</span>
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </TabsContent>

        <TabsContent value="browse" className="flex-1 flex flex-col min-h-0">
          <div className="flex-shrink-0">
            <ActionBar>
              <ActionBar.Left>
                <Input value={search} onChange={onSearch} placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')} />
              </ActionBar.Left>
              <ActionBar.Center />
              <ActionBar.Right>
                <CategorySelector initialValue={category} onSelect={setCategory} />
              </ActionBar.Right>
            </ActionBar>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0" data-testid="app-store-scroll-container">
            {!apps?.length && !isLoading ? (
              <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
            ) : (
              <div className="card px-3 pb-3" style={{ borderTopRightRadius: 0, borderTopLeftRadius: 0, minHeight: '100%' }}>
                <div className="row row-cards">
                  {isLoading && !apps.length
                    ? Array.from({ length: 12 }).map((_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Skeletons order doesn't change
                        <div key={`skeleton-${i}`} className="col-sm-6 col-lg-4">
                          <StoreTile
                            // biome-ignore lint/suspicious/noExplicitAny: Mock data for skeleton
                            app={{ urn: 'loading:loading', name: '', short_desc: '', categories: [] } as any}
                            isLoading={true}
                          />
                        </div>
                      ))
                    : apps.map((app, i) => {
                        const isLastElement = apps.length === i + 1;
                        return (
                          <div ref={isLastElement ? lastElementRef : null} key={app.urn} className="col-sm-6 col-lg-4 p-2 mt-4">
                            <StoreTile app={app} isLoading={false} />
                          </div>
                        );
                      })}
                  {isFetchingNextPage && (
                    <div className="col-12 text-center p-4">
                      <output className="spinner-border text-primary" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};
