import { getEnabledAppStoresOptions, searchAppsInfiniteOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';
import { StoreTile } from '@/modules/app/components/store-tile/store-tile';
import { useCallback, useEffect, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { useTranslation } from 'react-i18next';
import { StoreSelector } from '@/components/store-selector/store-selector';
import { CategorySelector } from '@/components/category-selector/category-selector';
import { ActionBar } from '@/components/action-bar/action-bar';
import { Navigate, useParams, useSearchParams } from 'react-router';

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

  const { setCategory, category, storeId, setStoreId, search: initialSearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(initialSearch);
  const { t } = useTranslation();

  useEffect(() => {
    if (selectedStore !== storeId) {
      setStoreId(selectedStore);
    }
  }, [selectedStore, setStoreId, storeId]);

  const { data: appStores } = useSuspenseQuery({
    ...getEnabledAppStoresOptions(),
  });

  const onSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalSearch(e.target.value);
      setSearch(e.target.value);
    },
    [setSearch],
  );

  const onSelectStore = useCallback(
    (value?: string) => {
      if (value) {
        setSearchParams({ store: value });
      } else {
        setSearchParams({});
      }
      setStoreId(value);
    },
    [setSearchParams, setStoreId],
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

  if (isLoading) {
    return <AppStorePageSuspense />;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0">
        <ActionBar>
          <ActionBar.Left>
            <Input value={search} onChange={onSearch} placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')} />
          </ActionBar.Left>
          <ActionBar.Center>
            {appStores.appStores.length > 1 ? (
              <StoreSelector initialValue={selectedStore} stores={appStores.appStores} onSelect={onSelectStore} />
            ) : null}
          </ActionBar.Center>
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
    </div>
  );
};
