import { cancelResetPasswordMutation, checkResetPasswordRequestOptions, resetPasswordMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ResetPasswordForm } from '../components/reset-password-form/reset-password-form';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isPasswordResetDisabled, domain } = useUserContext();

  const { data } = useSuspenseQuery({
    ...checkResetPasswordRequestOptions(),
  });

  const resetPassword = useMutation({
    ...resetPasswordMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  const cancelRequest = useMutation({
    ...cancelResetPasswordMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  if (resetPassword.data?.success && resetPassword.data?.email) {
    return (
      <>
        <h2 className="h2 text-center mb-4">{t('AUTH_RESET_PASSWORD_SUCCESS_TITLE')}</h2>
        <p className="text-secondary mb-4">
          <Trans
            t={t}
            i18nKey="AUTH_RESET_PASSWORD_SUCCESS"
            values={{
              username: resetPassword.data.email,
            }}
            components={{
              code: <code />,
            }}
          />
        </p>
        <Button onClick={() => navigate('/login')} type="button" intent="primary" className="w-100">
          {t('AUTH_RESET_PASSWORD_BACK_TO_LOGIN')}
        </Button>
      </>
    );
  }

  if (!data.isRequestPending) {
    if (isPasswordResetDisabled) {
      return (
        <div className="text-center">
          <div className="mb-4">
            <div className="mb-3">
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                className="icon icon-lg text-muted mb-2"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                strokeWidth="2"
                stroke="currentColor"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path stroke="none" d="M0 0h24v24H0z" fill="none" />
                <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
            </div>
            <h2 className="h2 text-center mb-3">Demo Account Credentials</h2>
            <p className="text-muted mb-4">For demo purposes, please use the following credentials to access the application.</p>
          </div>

          <div className="card bg-light mb-4">
            <div className="card-body">
              <div className="row g-3">
                <div className="col-12">
                  <div className="d-flex align-items-center justify-content-between">
                    <span className="text-muted fw-semibold">Email:</span>
                    <code className="fs-5 fw-bold text-primary">me@{domain}</code>
                  </div>
                </div>
                <div className="col-12">
                  <div className="d-flex align-items-center justify-content-between">
                    <span className="text-muted fw-semibold">Password:</span>
                    <code className="fs-5 fw-bold text-primary">{domain}</code>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="alert alert-info d-flex align-items-start mb-4" role="alert">
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              className="icon alert-icon me-2"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              strokeWidth="2"
              stroke="currentColor"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path stroke="none" d="M0 0h24v24H0z" fill="none" />
              <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <div>
              <strong>Need help?</strong> If you still can't log in with these credentials, please contact your system administrator for assistance.
            </div>
          </div>

          <Button asChild intent="primary" className="w-100">
            <Link to="/login">Back to Login</Link>
          </Button>
        </div>
      );
    }

    return (
      <>
        <h2 className="h2 text-center mb-4">{t('AUTH_RESET_PASSWORD_TITLE')}</h2>
        <p className="text-secondary mb-4">{t('AUTH_RESET_PASSWORD_INSTRUCTIONS')}</p>
        <pre>
          <code>./runtipi-cli reset-password</code>
        </pre>
      </>
    );
  }

  return (
    <ResetPasswordForm
      loading={resetPassword.isPending || cancelRequest.isPending}
      onCancel={() => cancelRequest.mutate({})}
      onSubmit={({ password }) => resetPassword.mutate({ body: { newPassword: password } })}
    />
  );
};
