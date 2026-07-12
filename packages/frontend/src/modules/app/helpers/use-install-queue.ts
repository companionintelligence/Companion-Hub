import { useQuery } from '@tanstack/react-query';
import { fetchInstallQueue, installQueueQueryKey, type InstallQueueState } from './install-queue';

function hasQueueActivity(queue: InstallQueueState | undefined): boolean {
  if (!queue) {
    return false;
  }

  return Boolean(queue.active) || (queue.queued?.length ?? 0) > 0;
}

/** Subscribe to the server install queue (DB `installing` rows + pipeline mutex). Always on; polls while work is pending. */
export const useInstallQueue = () => {
  return useQuery<InstallQueueState>({
    queryKey: installQueueQueryKey,
    queryFn: fetchInstallQueue,
    staleTime: 5_000,
    refetchInterval: (query) => (hasQueueActivity(query.state.data) ? 3_000 : false),
    refetchOnWindowFocus: true,
  });
};

export { hasQueueActivity };
