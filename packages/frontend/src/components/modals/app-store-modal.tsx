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
import { FullScreenModal } from '@/components/ui/full-screen-modal';

interface AppStoreModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AppStoreModal = ({ isOpen, onClose }: AppStoreModalProps) => {
  const { setCategory, category, storeId, setStoreId, search: initialSearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(initialSearch);
  const { t } = useTranslation();

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
      setStoreId(value);
    },
    [setStoreId],
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

  return (
    <FullScreenModal isOpen={isOpen} onClose={onClose} title={t('HEADER_APP_STORE')}>
      <ActionBar sticky>
        <ActionBar.Left>
          <Input value={search} onChange={onSearch} placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')} />
        </ActionBar.Left>
        <ActionBar.Center>
          {appStores.appStores.length > 1 ? (
            <StoreSelector initialValue={storeId} stores={appStores.appStores} onSelect={onSelectStore} />
          ) : null}
        </ActionBar.Center>
        <ActionBar.Right>
          <CategorySelector initialValue={category} onSelect={setCategory} />
        </ActionBar.Right>
      </ActionBar>

      {!apps?.length && !isLoading ? (
        <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
      ) : (
        <div className="row row-cards">
          {isLoading && !apps.length
            ? Array.from({ length: 12 }).map((_, i) => (
                <div key={`skeleton-${i}`} className="col-sm-6 col-lg-4">
                  <StoreTile
                    app={{ urn: 'loading:loading', name: '', short_desc: '', categories: [] } as any}
                    isLoading={true}
                  />
                </div>
              ))
            : apps.map((app, i) => {
                const isLastElement = apps.length === i + 1;
                return (
                  <div
                    ref={isLastElement ? lastElementRef : null}
                    key={`${app.id}-${app.storeId}`}
                    className="col-sm-6 col-lg-4"
                  >
                    <StoreTile app={app} isLoading={false} />
                  </div>
                );
              })}
          {isFetchingNextPage && (
            <div className="col-12 text-center p-4">
              <div className="spinner-border text-primary" role="status" />
            </div>
          )}
        </div>
      )}
    </FullScreenModal>
  );
};
