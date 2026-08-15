import { client } from '@/api-client/client.gen';
import { apiFetch, markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { getHubBaseUrlSync, isMobileClient } from '@/lib/mobile-connection';
import { buildPortalDesktopExchangeUrl } from '@/lib/portal-sso-url';
import { isViteLocalFrontend } from '@/lib/tauri-hub-probe';
import {
  clearPersistedDesktopPortalToken,
  persistDesktopPortalToken,
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

/** Listen for cihub:// / cihub-dev:// portal SSO handoffs and exchange the one-time token. */
export function useDesktopPortalAuth() {
  const { setUserContext } = useUserContext();
  const { t } = useTranslation();
  const processedDesktopPortalTokens = useRef(new Set<string>());
  const processedDesktopPortalErrors = useRef(new Set<string>());

  const completeDesktopPortalLogin = useCallback(
    async (payload: DesktopPortalAuthPayload | null) => {
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

      if (!payload.token) {
        return;
      }

      persistDesktopPortalToken(payload.token);

      if (processedDesktopPortalTokens.current.has(payload.token)) {
        return;
      }
      processedDesktopPortalTokens.current.add(payload.token);

      try {
        const isMobile = isMobileClient();
        const isTauriDesktop = isTauriDesktopApp();

        const exchangeAbsoluteUrl = buildPortalDesktopExchangeUrl({
          token: payload.token,
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
        if (!res.ok) {
          throw new Error(`Desktop portal exchange failed with status ${res.status}`);
        }

        const data = (await res.json()) as { sessionId: string; redirectPath: string };
        clearPersistedDesktopPortalToken();
        setTauriSessionId(data.sessionId);
        markHubSessionIssuedAt();
        setUserContext({ isLoggedIn: true });
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
        processedDesktopPortalTokens.current.delete(payload.token);
        toast.error(t('COMMON_AN_ERROR_OCCURRED'));
      }
    },
    [setUserContext, t],
  );

  useEffect(() => {
    // Hub Portal SSO handoff (cihub://auth?token=…) — desktop and mobile /login only.
    // Cloud connect PKCE (cihub://auth/callback) is handled separately in oidc.ts.
    if (!getTauriInvoke()) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let presenceTimer: ReturnType<typeof setInterval> | undefined;

    const announceDesktopPresence = () => {
      if (!isTauriDesktopApp()) {
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

      await completeDesktopPortalLogin(pending ?? { token: takePersistedDesktopPortalToken() ?? undefined });
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
