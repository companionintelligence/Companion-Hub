import { apiFetch, getTauriSessionId } from '@/lib/api-fetch';

/**
 * Carry on a navigation that needs the Hub session: an app's sign-in (`/sso`) or a Connect Memory
 * step (`/memory-connect/continue`).
 *
 * A navigation carries no header, and the Hub's cookie is no credential (it reaches every port on
 * the Hub's host), so the Hub API route a link opens only hands the browser to a Hub page, and the
 * page makes the request with the session token from its own storage. The answer is `{ url }`, the
 * place to go next; `replace`, so Back does not land on the relay and run it again.
 *
 * Not signed in: the sign-in page, which returns to this relay when it is done.
 */
export type RelayOutcome = { kind: 'navigated' } | { kind: 'signing-in' } | { kind: 'refused'; status: number; code?: string };

export async function relayNavigation(endpoint: string, body: Record<string, string>): Promise<RelayOutcome> {
  const toSignIn = (): RelayOutcome => {
    const here = new URL(`${window.location.pathname}${window.location.search}`, window.location.origin).toString();
    window.location.replace(`/login?redirect_url=${encodeURIComponent(here)}`);
    return { kind: 'signing-in' };
  };

  if (!getTauriSessionId()) {
    return toSignIn();
  }

  let response: Response;
  try {
    response = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'refused', status: 0 };
  }

  if (response.status === 401) {
    return toSignIn();
  }

  const answer = (await response.json().catch(() => null)) as { url?: unknown; code?: unknown } | null;
  if (!response.ok || typeof answer?.url !== 'string') {
    return { kind: 'refused', status: response.status, code: typeof answer?.code === 'string' ? answer.code : undefined };
  }

  window.location.replace(answer.url);
  return { kind: 'navigated' };
}
