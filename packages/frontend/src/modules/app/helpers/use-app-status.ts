import type { GetAppDto } from '@/api-client';
import { getAppQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { AppStatus } from '@/types/app.types';
import { useQueryClient } from '@tanstack/react-query';
import { produce } from 'immer';

export const useAppStatus = () => {
  const queryClient = useQueryClient();

  const setOptimisticStatus = (status: AppStatus, appUrn: string) => {
    const [appName, appStoreId] = appUrn.split(':');

    if (!appName || !appStoreId) {
      console.error('setOptimisticStatus -> Invalid app urn', appUrn);
      return;
    }

    const queryKey = getAppQueryKey({ path: { urn: appUrn } });
    const data = queryClient.getQueryData(queryKey) as GetAppDto | undefined;

    // No cache entry yet for an app that's never been fetched (e.g. installing straight from a
    // store listing without visiting its detail page first) — nothing to optimistically patch.
    // The detail page's own query populates the cache with real data on its next fetch.
    if (!data) {
      return;
    }

    const newData = produce(data, (draft) => {
      if (!draft.app) {
        draft.app = { id: appName, urn: appUrn, status } as unknown as GetAppDto['app'];
        return;
      }

      draft.app.status = status;
    });

    queryClient.setQueryData(queryKey, { ...newData });
  };

  return {
    setOptimisticStatus,
  };
};
