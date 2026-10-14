import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';

const fetchManageHub = async (): Promise<boolean> => {
  const res = await apiFetch('/api/hub-access');
  // A Hub that has no such route predates the owner/admin gate, so none of its routes refuse anyone.
  // Answering false there hid the Hub update button from its owner, and with it the way to a Hub that answers.
  if (res.status === 404) {
    return true;
  }
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
 *
 * `enabled: false` asks nothing, for a component that only needs the answer once it has something to show.
 */
export function useHubAccess({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ['hub-access'],
    queryFn: fetchManageHub,
    staleTime: 60_000,
    enabled,
  });

  return { manageHub: query.data === true, isPending: query.isPending };
}
