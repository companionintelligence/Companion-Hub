import { client } from '@/api-client/client.gen';
import { openExternal } from '@/lib/helpers/open-external';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';

/**
 * Open a URL in the system browser, first bridging the desktop Hub session into
 * that browser when running under Tauri.
 *
 * The desktop app's session lives in localStorage and rides only on `apiFetch`
 * request headers (X-CI-Hub-Session) — it cannot travel on a top-level navigation,
 * and the freshly-opened system browser holds no `ci-hub-sid` cookie. So a plain
 * external open of any Hub-gated URL (a marketplace app behind forward-auth, or the
 * memory-connect consent round-trip) lands on a second Hub login. This mints a
 * one-time handoff ticket (authenticated via the header session) and opens a Hub URL
 * that plants the session cookie in the system browser before continuing to
 * `targetUrl`.
 *
 * Fails open: outside Tauri (the browser already holds the cookie), or if minting
 * fails for any reason, it just opens `targetUrl` directly — the pre-existing
 * behavior, which at worst prompts the extra login rather than dead-ending.
 */
export async function openExternalWithHubSession(targetUrl: string): Promise<void> {
  // Web Hub: the current browser context already carries the session cookie, so a
  // handoff would be pointless churn. Only the Tauri webview has the split session.
  if (!getTauriInvoke()) {
    await openExternal(targetUrl);
    return;
  }

  try {
    const { data } = await client.post({
      url: '/api/auth/browser-handoff/mint',
      body: { next: targetUrl },
      throwOnError: true,
    });
    const handoffUrl = (data as { url?: string | null } | undefined)?.url;
    if (handoffUrl) {
      await openExternal(handoffUrl);
      return;
    }
  } catch {
    // Fall through to fail-open below.
  }

  await openExternal(targetUrl);
}
