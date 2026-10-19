import { registerMutation } from '@/api-client/@tanstack/react-query.gen';
import { userContext } from '@/api-client';
import { markHubSessionIssuedAt } from '@/lib/api-fetch';
import { firstOf, HUB_BOOTSTRAP_FETCH_MS } from '@/lib/hub-resume';
import { resolveRegistrationStatus } from '@/lib/registration-cache';
import { followSafeRedirect } from '@/lib/safe-redirect';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Navigate, redirect, useNavigate } from 'react-router';
import { PortalSignInSection } from '../components/portal-sign-in-section';
import { RegisterForm } from '../components/register-form';
import { usePortalSignIn } from '../hooks/use-portal-sign-in';

function loginHref(redirectUrl: string | null) {
  return redirectUrl ? `/login?redirect_url=${encodeURIComponent(redirectUrl)}` : '/login';
}

export async function clientLoader({ request }: { request?: Request } = {}) {
  const user = await userContext();

  if (user.data?.isLoggedIn) {
    return redirect('/home');
  }

  if (user.data?.isConfigured) {
    return redirect('/login');
  }

  // ⚠ NO SIGN-UP ON A PAIRED HUB. The form below makes a new CI Account, which is in no
  // organization, so a paired Hub revoked it at its next check-in and that person was locked out
  // (#2061). The backend refuses it as well; this sends the person to the sign-in that works.
  // Time-boxed like the root loader's own read of it: a hung status call must not leave this page
  // blank. With no answer the form renders. The backend still refuses it on a paired Hub.
  const status = await firstOf(resolveRegistrationStatus(), null, HUB_BOOTSTRAP_FETCH_MS);
  if (status?.registered) {
    return redirect(loginHref(request ? new URL(request.url).searchParams.get('redirect_url') : null));
  }

  return null;
}

export default () => {
  const { isLoggedIn, isConfigured, refreshUserContext, setUserContext } = useUserContext();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const redirectUrl = new URLSearchParams(window.location.search).get('redirect_url');
  // A paired Hub never renders this page once its status is read (the loader sends it to /login,
  // #2061), so this runs for an unpaired Hub or when the status couldn't be read. Offer the CI
  // Account sign-in here as well, so whoever lands here can still sign in rather than only make a
  // second account (#2059).
  const { authPolicy, portalSsoHref, portalAccountEmail, portalReachable, switchAccount } = usePortalSignIn(redirectUrl);

  const register = useMutation({
    ...registerMutation(),
    onSuccess: async (data) => {
      if (data?.requiresEmailVerification) {
        toast.success(t('AUTH_REGISTER_VERIFY_EMAIL'));
        return;
      }

      markHubSessionIssuedAt();
      setUserContext({ isLoggedIn: true, isConfigured: true });
      refreshUserContext();
      if (!followSafeRedirect(redirectUrl)) {
        navigate('/onboarding');
      }
    },
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      // The loader could not tell this Hub was paired. The backend could, so go where the toast says.
      if (e.message === 'AUTH_ERROR_REGISTER_PAIRED_HUB') {
        navigate(loginHref(redirectUrl), { replace: true });
      }
    },
  });

  if (isLoggedIn) {
    return <Navigate to="/home" replace />;
  }

  if (isConfigured) {
    return <Navigate to="/login" replace />;
  }

  return (
    <RegisterForm
      loading={register.isPending}
      onSubmit={(values) => register.mutate({ body: { password: values.password, username: values.email } })}
      portalSignIn={
        portalSsoHref ? (
          <PortalSignInSection
            portalSsoHref={portalSsoHref}
            portalAccountEmail={portalAccountEmail}
            openPortalSsoExternally={authPolicy.openHubSsoInSystemBrowser}
            onSwitchAccount={switchAccount}
            portalReachable={portalReachable}
            // The default hint points at a sign-in form that works offline. This form signs up at
            // Portal, so it is no way in while Portal is down either.
            unreachableHintKey="AUTH_REGISTER_PORTAL_UNREACHABLE"
          />
        ) : null
      }
      signInHref={loginHref(redirectUrl)}
    />
  );
};
