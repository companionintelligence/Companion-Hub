import { userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';
import { clearStaleTauriSession } from '@/lib/api-fetch';

let queryClientRef: QueryClient | null = null;
let handlingExpiry = false;
let pageHolds = 0;

/** Whether a page holds itself against the sign-in redirect right now (see `holdPageOnSessionExpiry`). */
export function isPageHeldOnSessionExpiry(): boolean {
  return pageHolds > 0;
}

/**
 * Keeps the page where it is when a request is refused, until the returned function is called.
 *
 * For a page that ends every session itself and still has something to say. A factory reset deletes
 * every user, so the open Settings page's next request is refused. Sent to sign-in on it, the page
 * lost the reset's toast within a second and its "the Portal still lists your apps" warning before
 * anyone could read it (#2557). The page that holds this leaves on its own once it is done.
 */
export function holdPageOnSessionExpiry(): () => void {
  pageHolds += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    pageHolds -= 1;
  };
}

export function bindSessionExpiredQueryClient(client: QueryClient): void {
  queryClientRef = client;
}

/** Clear client session state and send the user to login after a 401. */
export async function handleSessionExpired(): Promise<void> {
  if (handlingExpiry || pageHolds > 0 || typeof window === 'undefined') {
    return;
  }

  handlingExpiry = true;
  try {
    clearStaleTauriSession();
    if (queryClientRef) {
      await queryClientRef.cancelQueries({ queryKey: userContextQueryKey() });
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
