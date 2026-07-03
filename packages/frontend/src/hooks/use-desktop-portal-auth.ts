import { exchangePortalDesktopLogin } from '@/api-client/sdk.gen';
import { setTauriSessionId } from '@/lib/api-fetch';
import { takePendingDesktopPortalAuth, type DesktopPortalAuthPayload } from '@/lib/deep-link-auth';
import { portalErrorTranslationKey } from '@/lib/portal-auth-errors';
import { rememberPortalAccountEmail, resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { sdkResult } from '@/lib/sdk-unwrap';
import { useUserContext } from '@/context/user-context';
import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

const isTauriDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Listen for cihub:// / cihub-dev:// portal SSO handoffs and exchange the one-time token. */
export function useDesktopPortalAuth() {
  const { refreshUserContext, setUserContext } = useUserContext();
  const { t } = useTranslation();
  const navigate = useNavigate();
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

      if (processedDesktopPortalTokens.current.has(payload.token)) {
        return;
      }
      processedDesktopPortalTokens.current.add(payload.token);

      try {
        const result = await sdkResult(
          exchangePortalDesktopLogin({
            query: { token: payload.token },
          } as Parameters<typeof exchangePortalDesktopLogin>[0]),
        );
        if (!result.ok) {
          throw new Error(`Desktop portal exchange failed with status ${result.status}`);
        }

        const data = (result.data ?? {}) as { sessionId: string; redirectPath: string };
        setTauriSessionId(data.sessionId);
        setUserContext({ isLoggedIn: true });
        await refreshUserContext();
        const hint = await resolvePortalSessionHint();
        if (hint.email) {
          rememberPortalAccountEmail(hint.email);
        }
        navigate(data.redirectPath || '/home');
      } catch {
        processedDesktopPortalTokens.current.delete(payload.token);
        toast.error(t('COMMON_AN_ERROR_OCCURRED'));
      }
    },
    [navigate, refreshUserContext, setUserContext, t],
  );

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }

    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<DesktopPortalAuthPayload>('deep-link-auth', (event) => {
          void completeDesktopPortalLogin(event.payload);
        });
      } catch {
        // Non-desktop or deep-link listener unavailable.
      }

      const pending = await takePendingDesktopPortalAuth();
      await completeDesktopPortalLogin(pending);
    })();

    return () => {
      void unlisten?.();
    };
  }, [completeDesktopPortalLogin]);
}
