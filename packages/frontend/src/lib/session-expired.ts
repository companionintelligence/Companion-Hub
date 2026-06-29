import { userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';
import { clearStaleTauriSession } from '@/lib/api-fetch';

let queryClientRef: QueryClient | null = null;
let handlingExpiry = false;

export function bindSessionExpiredQueryClient(client: QueryClient): void {
  queryClientRef = client;
}

/** Clear client session state and send the user to login after a 401. */
export async function handleSessionExpired(): Promise<void> {
  if (handlingExpiry || typeof window === 'undefined') {
    return;
  }

  handlingExpiry = true;
  try {
    clearStaleTauriSession();
    if (queryClientRef) {
      await queryClientRef.invalidateQueries({ queryKey: userContextQueryKey() });
      queryClientRef.setQueryData(userContextQueryKey(), (current: { isLoggedIn?: boolean } | undefined) =>
        current ? { ...current, isLoggedIn: false } : current,
      );
    }

    if (!window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
  } finally {
    handlingExpiry = false;
  }
}
