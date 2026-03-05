import { cancelResetPasswordMutation, checkResetPasswordRequestOptions, resetPasswordMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ResetPasswordForm } from '../components/reset-password-form/reset-password-form';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isPasswordResetDisabled, domain } = useUserContext();

  const { data, isLoading } = useQuery({
    ...checkResetPasswordRequestOptions(),
    staleTime: 30_000,
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

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (resetPassword.data?.success && resetPassword.data?.email) {
    return (
      <>
        <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_RESET_PASSWORD_SUCCESS_TITLE')}</h2>
        <p className="text-sm text-muted-foreground mb-4">
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
        <Button onClick={() => navigate('/login')} type="button" intent="primary" className="w-full">
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
              <Info className="mx-auto h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold text-center mb-3">Demo Account Credentials</h2>
            <p className="text-sm text-muted-foreground mb-4">For demo purposes, please use the following credentials to access the application.</p>
          </div>

          <Card className="bg-muted/50 mb-4">
            <CardContent className="p-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground font-medium">Email:</span>
                  <code className="text-sm font-semibold text-primary">me@{domain}</code>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground font-medium">Password:</span>
                  <code className="text-sm font-semibold text-primary">{domain}</code>
                </div>
              </div>
            </CardContent>
          </Card>

          <Alert className="mb-4 text-left">
            <AlertDescription>
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <strong>Need help?</strong> If you still can't log in with these credentials, please contact your system administrator for
                  assistance.
                </div>
              </div>
            </AlertDescription>
          </Alert>

          <Button asChild intent="primary" className="w-full">
            <Link to="/login">Back to Login</Link>
          </Button>
        </div>
      );
    }

    return (
      <>
        <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_RESET_PASSWORD_TITLE')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{t('AUTH_RESET_PASSWORD_INSTRUCTIONS')}</p>
        <pre className="bg-muted/50 rounded-lg p-3 text-sm">
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
