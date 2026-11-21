import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';

/**
 * Whether this operator may give a key full capability. Asked on its own because answering it asks
 * the Portal, and the list must not wait on that. Any failure (a Hub that predates the route, an
 * outage) reads as yes: the screen then offers full as it always did, and the routes decide.
 */
export const fetchCanGrantFull = async (): Promise<boolean> => {
  try {
    const res = await apiFetch('/api/api-keys/grantable');
    if (!res.ok) {
      return true;
    }
    return ((await res.json()) as { canGrantFull?: boolean }).canGrantFull !== false;
  } catch {
    return true;
  }
};

/** {@link fetchCanGrantFull} as a query, for a control that offers `full` (a key's level, an app's MCP access). */
export function useCanGrantFull({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({ queryKey: ['api-keys-grantable'], queryFn: fetchCanGrantFull, staleTime: 60_000, enabled });
  return query.data !== false;
}
