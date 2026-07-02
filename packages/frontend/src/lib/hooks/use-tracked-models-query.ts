import { getTrackedModelsOptions } from '@/api-client/@tanstack/react-query.gen';
import { POLLING } from '@/lib/polling-budget';

export const trackedModelsQueryKey = getTrackedModelsOptions().queryKey;

export function useTrackedModelsQuery(options?: { enabled?: boolean; refetchWhilePulling?: boolean }) {
  const base = getTrackedModelsOptions();
  return {
    ...base,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchWhilePulling ? POLLING.MODEL_PULL_MS : false,
    staleTime: 30_000,
  } as const;
}

// Re-export for useQuery spread: useQuery(useTrackedModelsQuery({ refetchWhilePulling: true }))
export { getTrackedModelsOptions };
