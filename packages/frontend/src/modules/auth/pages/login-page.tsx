import { userContext } from '@/api-client';
import { loginMutation, verifyTotpMutation } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { exchangePortalDesktopLogin } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';
import { takePendingDesktopPortalAuth, type DesktopPortalAuthPayload } from '@/lib/deep-link-auth';
import { portalErrorTranslationKey } from '@/lib/portal-auth-errors';
import { rememberPortalAccountEmail, resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Navigate, redirect, useNavigate, useSearchParams } from 'react-router';
import { LoginForm } from '../components/login-form';
import { TotpForm } from '../components/totp-form/totp-form';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isSafeRedirect = (url: string) => new URL(url).host.endsWith(`.${window.location.host}`);

export async function clientLoader() {
  try {
    const user = await userContext();

    if (user.data?.isLoggedIn) {
      return redirect('/home');
    }
  } catch {
    // Backend may still be booting in the desktop app — render the login UI anyway.
    return null;
  }
}

export default () => {
  const { isLoggedIn, refreshUserContext, setUserContext } = useUserContext();
  const [totpSessionId, setTotpSessionId] = useState<string | null>(null);
  const [portalAccountEmail, setPortalAccountEmail] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const redirect_url = searchParams.get('redirect_url');
  const app = searchParams.get('app');
  const portalError = searchParams.get('portal_error');

  const { t } = useTranslation();
  const loginType = capitalize(app ?? '') || t('AUTH_LOGIN_LOCAL_ADMIN_ACCOUNT');

  useEffect(() => {
    if (!portalError) return;
    toast.error(t(portalErrorTranslationKey(portalError)));
    // Remove the error param from the URL so it doesn't persist on refresh.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('portal_error');
        return next;
      },
      { replace: true },
    );
  }, [portalError, setSearchParams, t]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const hint = await resolvePortalSessionHint();
      if (!cancelled && hint.email) {
        setPortalAccountEmail(hint.email);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useNavigate();
  const isTauriDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
    if (!isTauriDesktop) {
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
  }, [completeDesktopPortalLogin, isTauriDesktop]);

  const login = useMutation({
    ...loginMutation(),
    onSuccess: async (data) => {
      if (data?.success && data.totpSessionId) {
        setTotpSessionId(data.totpSessionId);
      } else {
        // Store session ID for Tauri release mode (cross-origin cookie fallback)
        if ((data as Record<string, unknown>)?.sessionId) {
          setTauriSessionId((data as Record<string, unknown>).sessionId as string);
        } else {
          markHubSessionIssuedAt();
        }
        setUserContext({ isLoggedIn: true });
        refreshUserContext();

        if (redirect_url && isSafeRedirect(redirect_url)) {
          window.location.href = redirect_url;
          return;
        }
        navigate('/home');
      }
    },
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  const verifyTotp = useMutation({
    ...verifyTotpMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (data) => {
      if ((data as Record<string, unknown>)?.sessionId) {
        setTauriSessionId((data as Record<string, unknown>).sessionId as string);
      } else {
        markHubSessionIssuedAt();
      }
      setUserContext({ isLoggedIn: true });
      refreshUserContext();

      if (redirect_url && isSafeRedirect(redirect_url)) {
        window.location.href = redirect_url;
        return;
      }
      navigate('/home');
    },
  });

  if (isLoggedIn) {
    if (redirect_url && isSafeRedirect(redirect_url)) {
      window.location.href = redirect_url;
      return;
    }
    return <Navigate to="/home" />;
  }

  if (totpSessionId) {
    return <TotpForm loading={verifyTotp.isPending} onSubmit={(totpCode) => verifyTotp.mutate({ body: { totpCode, totpSessionId } })} />;
  }

  const portalSsoHref = (() => {
    const baseUrl = isTauriDesktop ? client.getConfig().baseUrl || 'http://localhost:5002' : window.location.origin;
    const url = new URL('/api/auth/portal/start', baseUrl);
    if (redirect_url) {
      url.searchParams.set('redirect_url', redirect_url);
    }
    if (isTauriDesktop) {
      url.searchParams.set('desktop', '1');
    }
    return url.toString();
  })();

  return (
    <LoginForm
      onSubmit={(values) => login.mutate({ body: { password: values.password, username: values.email } })}
      loading={login.isPending}
      loginType={loginType}
      portalSsoHref={portalSsoHref}
      portalAccountEmail={portalAccountEmail}
    />
  );
};
