import { getEnabledAppStoresOptions, searchAppsInfiniteOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery, useQuery } from '@tanstack/react-query';
import { AppCard } from '@/modules/app/components/app-card/app-card';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { Input } from '@/components/ui/Input';
import { useTranslation } from 'react-i18next';
// Remove ActionBar import as it is no longer used
import { Navigate, useParams, useSearchParams, Link } from 'react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs/tabs';
import alts from '@/lib/data/alts.json';
import { iconForCategory, colorSchemeForCategory } from '@/modules/app/helpers/table-helpers';
import clsx from 'clsx';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';

const SKELETONS = Array.from({ length: 12 }, (_, i) => `skeleton-${i}`);

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
    <div className="h-full flex flex-col">
      <Tabs value={activeTab} onValueChange={onTabChange} className="h-full flex flex-col">
        <div className="flex-shrink-0 mb-4 px-6 pt-4">
          <TabsList>
            <TabsTrigger value="alternatives">Alternatives</TabsTrigger>
            <TabsTrigger value="browse">Browse</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="alternatives" className="flex-1 overflow-y-auto min-h-0 card p-4 mx-6 mb-6">
          {Object.entries(alts).map(([category, items]) => {
            const categoryInfo = iconForCategory.find((c) => c.id === category);
            const Icon = categoryInfo?.icon;
            const color = colorSchemeForCategory[category] || 'blue';

            return (
              <Card key={category} className="mb-4">
                <CardHeader>
                  <div className="flex items-center">
                    {Icon && <Icon className={clsx('icon me-2', `text-${color}`)} />}
                    <CardTitle className="capitalize">{category}</CardTitle>
                  </div>
                </CardHeader>
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
                                <div key={prop.name} className="flex items-center mr-3 mb-2" title={prop.name}>
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
                                      className="btn btn-ghost-primary flex items-center mr-2 mb-2"
                                    >
                                      {alt.icon && <span className="avatar avatar-xs me-2" style={{ backgroundImage: `url(${alt.icon})` }} />}
                                      {alt.name}
                                    </Link>
                                  );
                                }
                                return (
                                  <div key={alt.name} className="btn btn-ghost-secondary flex items-center mr-2 mb-2 opacity-50 cursor-not-allowed">
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
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="browse" className="flex-1 flex flex-col min-h-0" contentClassName="h-full flex flex-col p-0">
          <div className="flex-shrink-0 px-6 pt-4 pb-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight mb-2 text-foreground capitalize">App Store</h2>
              <p className="text-lg text-muted-foreground">Browse and manage your sovereign applications</p>
            </div>
          </div>
          <div className="flex h-full pt-4">
            {/* Left Sidebar */}
            <aside className="w-64 flex-shrink-0 border-r bg-muted/10 hidden md:flex flex-col ml-6 mb-6 rounded-2xl border">
              <div className="p-4 border-b">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground z-10" />
                  <Input placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')} className="pl-9" value={search} onChange={onSearch} />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto py-4 px-2 no-scrollbar">
                <div className="space-y-1">
                  <Button
                    variant="ghost"
                    className={clsx(
                      'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
                      category ? 'text-muted-foreground hover:bg-muted/50' : 'bg-primary/10 text-primary font-medium hover:bg-primary/20',
                    )}
                    onClick={() => setCategory(undefined)}
                  >
                    <span className="truncate">All Apps</span>
                  </Button>
                  {iconForCategory.map((cat) => {
                    const Icon = cat.icon;
                    const isSelected = category === cat.id;

                    return (
                      <Button
                        key={cat.id}
                        variant="ghost"
                        className={clsx(
                          'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
                          isSelected ? 'bg-primary/10 text-primary font-medium hover:bg-primary/20' : 'text-muted-foreground hover:bg-muted/50',
                        )}
                        onClick={() => setCategory(cat.id)}
                      >
                        {Icon && <Icon className="h-4 w-4" />}
                        <span className="truncate">{cat.id.charAt(0).toUpperCase() + cat.id.slice(1)}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            </aside>

            <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4" data-testid="app-store-scroll-container">
              {!apps?.length && !isLoading ? (
                <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
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
                            <AppCard app={app} isLoading={false} />
                          </div>
                        );
                      })}
                  {isFetchingNextPage && (
                    <div className="col-span-full text-center p-4">
                      <output className="spinner-border text-primary" />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};
