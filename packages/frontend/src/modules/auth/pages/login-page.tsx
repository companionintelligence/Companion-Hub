import { userContext } from '@/api-client';
import { loginMutation, verifyTotpMutation } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { portalErrorTranslationKey } from '@/lib/portal-auth-errors';
import { resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Navigate, redirect, useNavigate, useSearchParams } from 'react-router';
import { LoginForm } from '../components/login-form';
import { TotpForm } from '../components/totp-form/totp-form';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Where a post-login redirect may point: a relative path (`/…` but not `//…`, which browsers
 * treat as protocol-relative and would leave the origin), this exact origin (the edge-SSO mint
 * endpoint lives at `/api/auth/edge-sso` and loops back through here as an absolute same-origin
 * URL — CI-Engineering#77), or a subdomain of this host (the historical LAN app shape, where the
 * Hub sits at the domain root and apps live under it). Anything unparsable is unsafe — the old
 * bare `new URL(url)` THREW on a relative redirect_url, taking the whole login page down.
 */
export const isSafeRedirect = (url: string) => {
  if (url.startsWith('/') && !url.startsWith('//')) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.origin === window.location.origin || parsed.host.endsWith(`.${window.location.host}`);
  } catch {
    return false;
  }
};

export async function clientLoader() {
  try {
    const user = await userContext();

    if (user.data?.isLoggedIn) {
      // Honor a safe redirect target instead of dropping it: a visitor who signed in from
      // another tab mid-flow (e.g. between an edge-SSO bounce and this page) should continue to
      // where they were headed, not be stranded on /home.
      const redirectUrl = new URLSearchParams(window.location.search).get('redirect_url');
      if (redirectUrl && isSafeRedirect(redirectUrl)) {
        window.location.href = redirectUrl;
        return null;
      }
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
