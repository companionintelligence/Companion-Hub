import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';

/**
 * Matches the backend's `SESSION_TOKEN_FRAGMENT_KEY`: a sign-in that ends in a redirect (Portal, the
 * desktop's browser handoff) hands this page its session token in the URL fragment, which never
 * reaches a server. The Hub's cookie authenticates nothing, so this is how such a sign-in signs the
 * page in.
 */
export const SESSION_TOKEN_FRAGMENT_KEY = 'ci_hub_session';

/**
 * Take a session token out of the URL fragment, keep it, and remove it from the address bar and the
 * history entry. Run once, before the first request and before anything can navigate away.
 * Returns whether a token was found.
 */
export function adoptSessionTokenFromFragment(): boolean {
  if (typeof window === 'undefined' || !window.location.hash) {
    return false;
  }

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get(SESSION_TOKEN_FRAGMENT_KEY);
  if (!token) {
    return false;
  }

  fragment.delete(SESSION_TOKEN_FRAGMENT_KEY);
  const rest = fragment.toString();
  const url = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`;
  try {
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // Some embedded webviews refuse replaceState; the token is still kept below.
  }

  setTauriSessionId(token);
  markHubSessionIssuedAt();
  return true;
}
