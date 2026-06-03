import { useQuery } from '@tanstack/react-query';
import { fetchInstallQueue, installQueueQueryKey, type InstallQueueState } from './install-queue';

export const useInstallQueue = (enabled: boolean) => {
  return useQuery<InstallQueueState>({
    queryKey: installQueueQueryKey,
    queryFn: fetchInstallQueue,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: enabled,
  });
};
