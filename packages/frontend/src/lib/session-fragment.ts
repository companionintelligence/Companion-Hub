import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';

/**
 * Matches the backend's `SESSION_TOKEN_FRAGMENT_KEY`: a sign-in that ends in a redirect (Portal, the
 * desktop's browser handoff) hands this page its session token in the URL fragment, which never
 * reaches a server. The Hub's cookie authenticates nothing, so this is how such a sign-in signs the
 * page in.
 */
export const SESSION_TOKEN_FRAGMENT_KEY = 'ci_hub_session';

/** Matches the backend's `SESSION_HANDOFF_NONCE_KEY`: the value beside the token that ties it to this browser. */
export const SESSION_HANDOFF_NONCE_KEY = 'ci_hub_nonce';

/**
 * The hand-off cookie the redirect set beside the fragment (backend `sessionHandoffCookie`).
 *
 * Over https only the `__Host-` name counts: the browser keeps that one only from this host, so an
 * app on a sibling address cannot plant it. The plain name an http Hub sets is taken over http only.
 */
function handoffCookieName(): string {
  return window.location.protocol === 'https:' ? '__Host-ci-hub-handoff' : 'ci-hub-handoff';
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function clearCookie(name: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from Firefox and older Safari
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
}

/**
 * Take a session token out of the URL fragment, keep it, and remove it from the address bar and the
 * history entry. Run once, before the first request and before anything can navigate away.
 * Returns whether a token was adopted.
 *
 * ⚠ ONLY A TOKEN THIS BROWSER WAS HANDED. A link to a Hub page can carry anyone's token, and adopting
 * it signed the visitor in to that account without a word: whatever they then did or entered went to
 * it. The Hub's own redirect sets the hand-off cookie in the same response and repeats its value in
 * the fragment, so the token is kept only when the two match. A mismatch keeps whatever session the
 * page already had. The fragment and the cookie are both removed either way: each is single use.
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
  const nonce = fragment.get(SESSION_HANDOFF_NONCE_KEY);

  fragment.delete(SESSION_TOKEN_FRAGMENT_KEY);
  fragment.delete(SESSION_HANDOFF_NONCE_KEY);
  const rest = fragment.toString();
  const url = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`;
  try {
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // Some embedded webviews refuse replaceState; the token is still handled below.
  }

  const cookieName = handoffCookieName();
  const expected = readCookie(cookieName);
  clearCookie(cookieName);
  if (!nonce || !expected || nonce !== expected) {
    console.warn('[sign-in] Ignored a session token this browser was not handed (no matching hand-off cookie).');
    return false;
  }

  setTauriSessionId(token);
  markHubSessionIssuedAt();
  return true;
}
