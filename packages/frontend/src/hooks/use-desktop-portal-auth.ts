import { client } from '@/api-client/client.gen';
import { apiFetch, markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { hubAuthFlowPolicy, readHubAuthFlow } from '@/lib/hub-auth-flow';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { getHubBaseUrlSync, isMobileClient } from '@/lib/mobile-connection';
import { buildPortalDesktopExchangeUrl } from '@/lib/portal-sso-url';
import { isViteLocalFrontend } from '@/lib/tauri-hub-probe';
import {
  clearPersistedDesktopPortalToken,
  isUsedDesktopPortalToken,
  persistDesktopPortalToken,
  rememberUsedDesktopPortalToken,
  takePendingDesktopPortalAuth,
  takePersistedDesktopPortalToken,
  type DesktopPortalAuthPayload,
} from '@/lib/deep-link-auth';
import { portalErrorTranslationKey } from '@/lib/portal-auth-errors';
import { rememberPortalAccountEmail, resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { useUserContext } from '@/context/user-context';
import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

/** One toast for a link, however many copies of it fail. */
const DESKTOP_PORTAL_EXCHANGE_TOAST_ID = 'desktop-portal-exchange';

/** Listen for cihub:// / cihub-dev:// portal SSO handoffs and exchange the one-time token. */
export function useDesktopPortalAuth() {
  const { setUserContext, isLoggedIn } = useUserContext();
  const { t } = useTranslation();
  const processedDesktopPortalTokens = useRef(new Set<string>());
  const processedDesktopPortalErrors = useRef(new Set<string>());
  // Read through a ref so the listener effect subscribes once per mount. While it depended on these,
  // every user-context update re-ran it: another presence heartbeat, another listener, and another
  // pass over the saved token.
  const latest = useRef({ setUserContext, isLoggedIn, t });
  useEffect(() => {
    latest.current = { setUserContext, isLoggedIn, t };
  });

  /** `recovered`: the token came back from storage after a reload, not from a link just opened. */
  const completeDesktopPortalLogin = useCallback(async (payload: DesktopPortalAuthPayload | null, { recovered = false } = {}) => {
    const { t } = latest.current;
    if (!payload) {
      return;
    }

    if (payload.error) {
      if (processedDesktopPortalErrors.current.has(payload.error)) {
        return;
      }
      processedDesktopPortalErrors.current.add(payload.error);
      toast.error(t(portalErrorTranslationKey(payload.error)));
      return;
    }

    const token = payload.token;
    if (!token || processedDesktopPortalTokens.current.has(token)) {
      return;
    }

    // A one-time token the Hub already answered can only be refused again, so a repeat of the same
    // link is dropped here rather than sent.
    if (isUsedDesktopPortalToken(token)) {
      if (takePersistedDesktopPortalToken() === token) {
        clearPersistedDesktopPortalToken();
      }
      return;
    }

    processedDesktopPortalTokens.current.add(token);
    persistDesktopPortalToken(token);

    try {
      const isMobile = isMobileClient();
      const isTauriDesktop = isTauriDesktopApp();

      const exchangeAbsoluteUrl = buildPortalDesktopExchangeUrl({
        token,
        remoteHubUrl: getHubBaseUrlSync(),
        isTauriDesktop,
        isMobileClient: isMobile,
        configuredApiBaseUrl: client.getConfig().baseUrl,
        pageOrigin: window.location.origin,
      });

      const parsedExchange = new URL(exchangeAbsoluteUrl);
      const exchangePath = `${parsedExchange.pathname}${parsedExchange.search}`;

      // local:desktop must stay same-origin on :5005 so the session cookie lands in the webview.
      if (isViteLocalFrontend() && isTauriDesktop) {
        client.setConfig({ baseUrl: '', credentials: 'include' });
      } else if (isMobile && getHubBaseUrlSync()) {
        client.setConfig({ baseUrl: getHubBaseUrlSync() ?? '', credentials: 'omit' });
      } else if (parsedExchange.origin === window.location.origin) {
        client.setConfig({ baseUrl: '', credentials: 'include' });
      } else {
        client.setConfig({ baseUrl: parsedExchange.origin, credentials: 'omit' });
      }

      const res = await apiFetch(exchangePath, { credentials: client.getConfig().credentials ?? 'include' });
      if (res.status >= 400 && res.status < 500) {
        // Used, expired or unknown. The token can never succeed, so forget it: left saved, it was
        // retried and refused, with a toast, on every page load. Only a link just opened by someone
        // not signed in gets told: anyone else was handed a stale copy and has nothing to redo.
        rememberUsedDesktopPortalToken(token);
        clearPersistedDesktopPortalToken();
        if (!recovered && !latest.current.isLoggedIn) {
          toast.error(t('AUTH_PORTAL_ERROR_STATE_EXPIRED'), { id: DESKTOP_PORTAL_EXCHANGE_TOAST_ID });
        }
        return;
      }
      if (!res.ok) {
        throw new Error(`Desktop portal exchange failed with status ${res.status}`);
      }

      const data = (await res.json()) as { sessionId: string; redirectPath: string };
      rememberUsedDesktopPortalToken(token);
      clearPersistedDesktopPortalToken();
      setTauriSessionId(data.sessionId);
      markHubSessionIssuedAt();
      latest.current.setUserContext({ isLoggedIn: true });
      void (async () => {
        const hint = await resolvePortalSessionHint();
        if (hint.email) {
          rememberPortalAccountEmail(hint.email);
        }
      })();
      // Hard navigation so the WebView loads with the new cookie + stored session id,
      // same as a fresh password login — client-side navigate races authenticated-route.
      window.location.assign(data.redirectPath || '/home');
    } catch {
      // Not refused, just not answered (network, Hub restarting): another copy of the link may try
      // again, but a saved token must not, or it retries on every page load.
      processedDesktopPortalTokens.current.delete(token);
      clearPersistedDesktopPortalToken();
      toast.error(t('COMMON_AN_ERROR_OCCURRED'), { id: DESKTOP_PORTAL_EXCHANGE_TOAST_ID });
    }
  }, []);

  useEffect(() => {
    // Hub Portal SSO handoff (cihub://auth?token=…) — desktop-hub-sso and
    // mobile-hub-sso only. Cloud-connect PKCE (cihub://auth/callback) is oidc.ts.
    const policy = hubAuthFlowPolicy(readHubAuthFlow());
    if (!getTauriInvoke() || !policy.listenDeepLinkAuth) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let presenceTimer: ReturnType<typeof setInterval> | undefined;

    const announceDesktopPresence = () => {
      if (!policy.announceDesktopPresence) {
        return;
      }
      void apiFetch('/api/auth/portal/session-hint?desktop=1').catch(() => undefined);
    };

    announceDesktopPresence();
    presenceTimer = setInterval(announceDesktopPresence, 60_000);

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) {
          return;
        }

        unlisten = await listen<DesktopPortalAuthPayload>('deep-link-auth', (event) => {
          void completeDesktopPortalLogin(event.payload);
          // The shell parks every link for a page that is not listening yet, as well as emitting it.
          // This page was listening, so empty that slot, or the page load that follows sign-in takes
          // the same link from it and exchanges it again. Anything else parked there still runs.
          void takePendingDesktopPortalAuth().then((parked) => completeDesktopPortalLogin(parked));
        });

        if (cancelled) {
          void unlisten?.();
          unlisten = undefined;
          return;
        }
      } catch {
        // Deep-link listener unavailable (unit tests / late IPC).
      }

      if (cancelled) {
        return;
      }

      const pending = await takePendingDesktopPortalAuth();
      if (cancelled) {
        return;
      }

      if (pending) {
        await completeDesktopPortalLogin(pending);
        return;
      }
      await completeDesktopPortalLogin({ token: takePersistedDesktopPortalToken() ?? undefined }, { recovered: true });
    })();

    return () => {
      cancelled = true;
      if (presenceTimer) {
        clearInterval(presenceTimer);
      }
      void unlisten?.();
    };
  }, [completeDesktopPortalLogin]);
}
