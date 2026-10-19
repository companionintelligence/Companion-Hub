import { registerMutation } from '@/api-client/@tanstack/react-query.gen';
import { userContext } from '@/api-client';
import { markHubSessionIssuedAt } from '@/lib/api-fetch';
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

export async function clientLoader() {
  const user = await userContext();

  if (user.data?.isLoggedIn) {
    return redirect('/home');
  }

  if (user.data?.isConfigured) {
    return redirect('/login');
  }

  return null;
}

export default () => {
  const { isLoggedIn, isConfigured, refreshUserContext, setUserContext } = useUserContext();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const redirectUrl = new URLSearchParams(window.location.search).get('redirect_url');
  // A paired Hub with no operator opens here, and whoever paired it already has a CI Account.
  // Offer the same sign-in `/login` does, or that person can only make a second account (#2059).
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
      if (!followSafeRedirect(new URLSearchParams(window.location.search).get('redirect_url'))) {
        navigate('/onboarding');
      }
    },
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
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
          />
        ) : null
      }
      signInHref={redirectUrl ? `/login?redirect_url=${encodeURIComponent(redirectUrl)}` : '/login'}
    />
  );
};
