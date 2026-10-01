import { userContext } from '@/api-client';
import { loginMutation, verifyTotpMutation } from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { portalErrorTranslationKey } from '@/lib/portal-auth-errors';
import { SIGNED_OUT_PARAM, signedOutTranslationKey } from '@/lib/signed-out-reasons';
import { forgetPortalAccountEmail, resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { hubAuthFlowPolicy, resolveHubAuthFlow } from '@/lib/hub-auth-flow';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { clearHubConnection, getHubBaseUrlSync, isMobileClient, usesCloudConnect } from '@/lib/mobile-connection';
import { shouldTimeBoxMobileLoads } from '@/lib/use-mobile-load-timeout';
import { buildPortalSsoStartUrl } from '@/lib/portal-sso-url';
import { followSafeRedirect } from '@/lib/safe-redirect';
import { AuthSessionCancelledError, openAuthSession } from '@/lib/helpers/open-auth-browser';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Navigate, redirect, useNavigate, useSearchParams } from 'react-router';
import { LoginForm } from '../components/login-form';
import { TotpForm } from '../components/totp-form/totp-form';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the server answers when the pending sign-in no longer exists, whatever a new code would be. */
const TOTP_SESSION_ENDED_ERRORS: ReadonlySet<string> = new Set([
  'AUTH_ERROR_TOTP_SESSION_NOT_FOUND',
  'AUTH_ERROR_TOTP_TOO_MANY_ATTEMPTS',
  'AUTH_ERROR_USER_NOT_FOUND',
  'AUTH_ERROR_NOT_ORG_MEMBER',
  'AUTH_ERROR_TOTP_NOT_ENABLED',
]);

export async function clientLoader({ request }: { request: Request }) {
  try {
    // A phone talking to a remote Hub must not wait forever on user-context.
    // ios:dev often has no native HTTP yet; a hung GET leaves a blank /login.
    const user = shouldTimeBoxMobileLoads()
      ? await Promise.race([
          userContext(),
          new Promise<null>((resolve) => {
            globalThis.setTimeout(() => resolve(null), 5000);
          }),
        ])
      : await userContext();
    if (!user) {
      return null;
    }

    if (user.data?.isLoggedIn) {
      // Honor a safe redirect target instead of dropping it: a visitor who signed in from
      // another tab mid-flow (e.g. between an edge-SSO bounce and this page) should continue to
      // where they were headed, not be stranded on /home.
      //
      // Read from the loader's request, not `window.location`: on a client-side navigation the
      // address bar still holds the PREVIOUS route while loaders run, so this would pick up that
      // page's `redirect_url` (or miss this one entirely).
      if (followSafeRedirect(new URL(request.url).searchParams.get('redirect_url'))) {
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
  const [portalReachable, setPortalReachable] = useState(true);

  const [searchParams, setSearchParams] = useSearchParams();
  const redirect_url = searchParams.get('redirect_url');
  const app = searchParams.get('app');
  const portalError = searchParams.get('portal_error');
  const signedOutReason = searchParams.get(SIGNED_OUT_PARAM);

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
    if (!signedOutReason) return;
    // Confirmation for an action taken on the page we just reloaded away from — a
    // password or username change signs every session out, so its toast could not
    // survive where it was raised. Strip the param either way, so a refresh does not
    // replay it.
    const messageKey = signedOutTranslationKey(signedOutReason);
    if (messageKey) toast.success(t(messageKey));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(SIGNED_OUT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [signedOutReason, setSearchParams, t]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const hint = await resolvePortalSessionHint();
      if (!cancelled) {
        setPortalReachable(hint.portalReachable);
        if (hint.email) {
          setPortalAccountEmail(hint.email);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useNavigate();
  const isMobile = isMobileClient();
  const remoteHubUrl = getHubBaseUrlSync();
  const isTauriDesktop = isTauriDesktopApp();
  const authFlow = resolveHubAuthFlow({
    usesCloudConnect: usesCloudConnect(),
    remoteHubUrl,
    isTauriDesktop,
  });
  const authPolicy = hubAuthFlowPolicy(authFlow);

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

        if (followSafeRedirect(redirect_url)) {
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

      // The sign-in is over, so the code form has nothing left to submit to: go back to the password.
      if (TOTP_SESSION_ENDED_ERRORS.has(e.message)) {
        setTotpSessionId(null);
      }
    },
    onSuccess: (data) => {
      if ((data as Record<string, unknown>)?.sessionId) {
        setTauriSessionId((data as Record<string, unknown>).sessionId as string);
      } else {
        markHubSessionIssuedAt();
      }
      setUserContext({ isLoggedIn: true });
      refreshUserContext();

      if (followSafeRedirect(redirect_url)) {
        return;
      }
      navigate('/home');
    },
  });

  if (isLoggedIn) {
    if (followSafeRedirect(redirect_url)) {
      return;
    }
    return <Navigate to="/home" />;
  }

  if (totpSessionId) {
    return <TotpForm loading={verifyTotp.isPending} onSubmit={(totpCode) => verifyTotp.mutate({ body: { totpCode, totpSessionId } })} />;
  }

  const portalSsoHref = authPolicy.usesHubPortalSso
    ? buildPortalSsoStartUrl({
        remoteHubUrl,
        isTauriDesktop,
        isMobileClient: isMobile,
        configuredApiBaseUrl: client.getConfig().baseUrl,
        pageOrigin: window.location.origin,
        redirectUrl: redirect_url,
      })
    : undefined;

  return (
    <>
      <LoginForm
        onSubmit={(values) => login.mutate({ body: { password: values.password, username: values.email } })}
        loading={login.isPending}
        loginType={loginType}
        portalSsoHref={portalSsoHref}
        portalAccountEmail={portalAccountEmail}
        portalReachable={portalReachable}
        openPortalSsoExternally={authPolicy.openHubSsoInSystemBrowser}
        allowPasswordLogin={!isMobile}
        onSwitchAccount={() => {
          forgetPortalAccountEmail();
          setPortalAccountEmail(null);
          if (portalSsoHref) {
            if (authPolicy.openHubSsoInSystemBrowser) {
              // Same reasoning as the sign-in button in login-form: the opener
              // rejects on an ACL/plugin failure, and swallowing that leaves a
              // switcher that looks clicked and does nothing.
              openAuthSession(portalSsoHref).catch((error: unknown) => {
                if (error instanceof AuthSessionCancelledError) {
                  return;
                }
                console.error('login: the system opener refused the SSO URL', error);
                toast.error(t('COMMON_AN_ERROR_OCCURRED'));
              });
              return;
            }
            window.location.assign(portalSsoHref);
          }
        }}
      />
      {authPolicy.showSwitchHub ? (
        <button
          type="button"
          data-testid="login-switch-hub-btn"
          className="mx-auto mt-6 block min-h-[44px] text-sm text-muted-foreground underline"
          onClick={() => {
            void clearHubConnection().finally(() => window.location.assign('/connect'));
          }}
        >
          {t('MOBILE_CONNECT_SWITCH_HUB')}
        </button>
      ) : null}
    </>
  );
};
