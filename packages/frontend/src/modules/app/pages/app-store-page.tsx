import { getEnabledAppStoresOptions, searchAppsInfiniteOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery, useQuery } from '@tanstack/react-query';
import { AppCard } from '@/modules/app/components/app-card/app-card';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { Input } from '@/components/ui/Input';
import { Navigate, useParams, Link } from 'react-router';
import alts from '@/lib/data/alts.json';

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
import { iconForCategory, colorSchemeForCategory } from '@/modules/app/helpers/table-helpers';
import clsx from 'clsx';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { Search, ArrowRight, ArrowLeftRight, LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/Button';

const SKELETONS = Array.from({ length: 12 }, (_, i) => `skeleton-${i}`);

const ALTERNATIVES_VIEW = '__alternatives__';

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
  const { setCategory, category, storeId, setStoreId, search: initialSearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(initialSearch);
  const { data: registrationStatus, isLoading: isCheckingRegistration, error: registrationError } = useRegistrationStatus();

  const isAlternativesView = category === ALTERNATIVES_VIEW;

  useEffect(() => {
    if (!isCheckingRegistration) {
      if (registrationError || (registrationStatus && !registrationStatus.registered)) {
        window.location.href = '/device-registration';
      }
    }
  }, [registrationStatus, isCheckingRegistration, registrationError]);

  const { data: appStores } = useSuspenseQuery({
    ...getEnabledAppStoresOptions(),
  });

  const ciCloudStore = appStores?.appStores?.find((s) => s.name === 'CI Cloud');

  const { data: allAppsData } = useQuery({
    ...searchAppsOptions({
      query: { pageSize: 1000, storeId: ciCloudStore?.slug },
    }),
    enabled: !!ciCloudStore && isAlternativesView,
  });

  const availableAppSlugs = useMemo(() => {
    if (!allAppsData?.data) return new Set<string>();
    return new Set(allAppsData.data.filter((app) => app.available).map((app) => app.id));
  }, [allAppsData]);

  useEffect(() => {
    if (appStores?.appStores) {
      if (ciCloudStore && storeId !== ciCloudStore.slug) {
        setStoreId(ciCloudStore.slug);
      } else if (!ciCloudStore && !storeId && appStores.appStores.length > 0) {
        setStoreId(appStores.appStores[0]?.slug);
      }
    }
  }, [appStores, storeId, setStoreId, ciCloudStore]);

  const onSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalSearch(e.target.value);
      setSearch(e.target.value);
    },
    [setSearch],
  );

  const effectiveCategory = isAlternativesView ? undefined : category;

  const { data, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = useInfiniteQuery({
    ...searchAppsInfiniteOptions({ query: { search, category: effectiveCategory, pageSize: 24, storeId } }),
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

  // Filter alternatives by search query
  const filteredAlts = useMemo(() => {
    if (!search) return alts;
    const q = search.toLowerCase();
    const result: Record<string, (typeof alts)[keyof typeof alts]> = {};
    for (const [cat, items] of Object.entries(alts)) {
      const filtered = (items as AltItem[]).filter((item) => {
        const propMatch = item.proprietary.some((p) => p.name.toLowerCase().includes(q));
        const altMatch = item.alternatives.some((a) => a.name.toLowerCase().includes(q));
        const catMatch = cat.toLowerCase().includes(q);
        return propMatch || altMatch || catMatch;
      });
      if (filtered.length > 0) {
        result[cat] = filtered as (typeof alts)[keyof typeof alts];
      }
    }
    return result;
  }, [search]);

  if (params.storeId) {
    return <Navigate to={`/app-store?store=${params.storeId}`} />;
  }

  if (isCheckingRegistration || (registrationStatus && !registrationStatus.registered)) {
    return <AppStorePageSuspense />;
  }

  if (isLoading) {
    return <AppStorePageSuspense />;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-6 pt-6 pb-2">
        <h2 className="text-3xl font-bold tracking-tight mb-2 text-foreground">App Store</h2>
        <p className="text-muted-foreground">Discover and manage your applications</p>
      </div>

      <div className="flex flex-1 min-h-0 pt-4">
        {/* Left Sidebar */}
        <aside className="w-64 flex-shrink-0 border-r bg-muted/10 hidden md:flex flex-col ml-6 mb-6 rounded-2xl border">
          <div className="p-4 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground z-10" />
              <Input placeholder="Search apps..." className="pl-9 bg-muted/50" value={search} onChange={onSearch} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-4 px-2 no-scrollbar">
            <div className="space-y-1">
              {/* All Apps */}
              <Button
                variant="ghost"
                className={clsx(
                  'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
                  category ? 'text-muted-foreground hover:bg-muted/50' : 'bg-primary/10 text-primary font-medium hover:bg-primary/20',
                )}
                onClick={() => setCategory(undefined)}
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="truncate">All</span>
              </Button>

              {/* Alternatives - special item */}
              <div className="my-2 mx-3 border-t border-border/50" />
              <Button
                variant="ghost"
                className={clsx(
                  'w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto',
                  isAlternativesView ? 'bg-primary/10 text-primary font-medium hover:bg-primary/20' : 'text-muted-foreground hover:bg-muted/50',
                )}
                onClick={() => setCategory(ALTERNATIVES_VIEW)}
              >
                <ArrowLeftRight className="h-4 w-4" />
                <span className="truncate">Alternatives</span>
              </Button>
              <div className="my-2 mx-3 border-t border-border/50" />

              {/* Categories */}
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

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4" data-testid="app-store-scroll-container">
          {/* Mobile Search & Categories */}
          <div className="md:hidden space-y-4 mb-6">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search apps..." className="pl-9 bg-muted/50" value={search} onChange={onSearch} />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar -mx-6 px-6">
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
                All
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
                Alternatives
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
                    {cat.id.charAt(0).toUpperCase() + cat.id.slice(1)}
                  </Button>
                );
              })}
            </div>
          </div>
          {isAlternativesView ? (
            <div className="space-y-6">
              {Object.keys(filteredAlts).length === 0 ? (
                <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
              ) : (
                Object.entries(filteredAlts).map(([altCategory, items]) => {
                  const categoryInfo = iconForCategory.find((c) => c.id === altCategory);
                  const Icon = categoryInfo?.icon;
                  const color = colorSchemeForCategory[altCategory] || 'blue';

                  return (
                    <Card key={altCategory} className="overflow-hidden">
                      <CardHeader className="border-b bg-muted/30 py-4 px-6">
                        <div className="flex items-center gap-2">
                          {Icon && <Icon className={clsx('h-5 w-5', `text-${color}`)} />}
                          <CardTitle className="capitalize text-base">{altCategory}</CardTitle>
                        </div>
                      </CardHeader>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableHead className="w-1/2 font-semibold">Proprietary</TableHead>
                            <TableHead className="w-1/2 font-semibold">Open Source Alternatives</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(items as AltItem[]).map((item, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Static list
                            <TableRow key={index}>
                              <TableCell className="py-3">
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
                              <TableCell className="py-3">
                                <div className="flex flex-wrap gap-2">
                                  {item.alternatives.map((alt) => {
                                    const isAvailable = alt.appSlug && availableAppSlugs.has(alt.appSlug) && ciCloudStore;
                                    if (isAvailable) {
                                      return (
                                        <Link
                                          key={alt.name}
                                          to={`/app-store/${ciCloudStore.slug}/${alt.appSlug}`}
                                          className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
                                        >
                                          {alt.icon && (
                                            <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover" loading="lazy" />
                                          )}
                                          {alt.name}
                                          <ArrowRight className="h-3 w-3" />
                                        </Link>
                                      );
                                    }
                                    return (
                                      <div
                                        key={alt.name}
                                        className="flex items-center gap-2 rounded-full bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
                                      >
                                        {alt.icon && (
                                          <img src={alt.icon} alt={alt.name} className="h-5 w-5 rounded-full object-cover grayscale" loading="lazy" />
                                        )}
                                        {alt.name}
                                        <span className="text-xs bg-muted/50 px-1.5 py-0.5 rounded-full">Soon</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  );
                })
              )}
            </div>
          ) : !apps?.length && !isLoading ? (
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
    </div>
  );
};
