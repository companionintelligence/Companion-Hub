import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';

const fetchManageHub = async (): Promise<boolean> => {
  const res = await apiFetch('/api/hub-access');
  if (!res.ok) {
    return false;
  }
  const body = (await res.json()) as { manageHub?: unknown };
  return body.manageHub === true;
};

/**
 * Whether the signed-in person may change what applies to the whole Hub (its settings, keys, AI
 * providers, updates, pool, app stores, registration and factory reset) and read the Hub's own log.
 * Organization owners and admins may; a member is view-only. Pages show those controls only when
 * `manageHub` is true, so a member meets no button the Hub would refuse; the Hub still decides every call.
 *
 * The Hub answers from the role it stored at sign-in, without a Portal call. The answer is kept for a
 * minute. Until it arrives, and when it fails, `manageHub` is false and `isPending` says which.
 */
export function useHubAccess() {
  const query = useQuery({
    queryKey: ['hub-access'],
    queryFn: fetchManageHub,
    staleTime: 60_000,
  });

  return { manageHub: query.data === true, isPending: query.isPending };
}
