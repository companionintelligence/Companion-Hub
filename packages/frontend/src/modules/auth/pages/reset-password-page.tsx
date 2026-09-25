import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { completeResetPassword, requestResetPassword, verifyResetPasswordToken } from '@/lib/auth-password-reset-api';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ResetPasswordForm } from '../components/reset-password-form/reset-password-form';

type RequestFormValues = { email: string };
type TokenStatus = 'loading' | 'valid' | 'invalid';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const hasToken = token.length > 0;

  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>('loading');
  const [isRequestPending, setIsRequestPending] = useState(false);
  const [isCompletionPending, setIsCompletionPending] = useState(false);
  const [isCompleteSuccess, setIsCompleteSuccess] = useState(false);

  const requestSchema = useMemo(
    () =>
      z.object({
        email: z.string().email(),
      }),
    [],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RequestFormValues>({
    resolver: zodResolver(requestSchema),
  });

  useEffect(() => {
    if (!hasToken) {
      return;
    }

    let active = true;

    const verifyToken = async () => {
      setTokenStatus('loading');
      try {
        const valid = await verifyResetPasswordToken(token);
        if (!active) {
          return;
        }
        setTokenStatus(valid ? 'valid' : 'invalid');
      } catch {
        if (!active) {
          return;
        }
        setTokenStatus('invalid');
      }
    };

    void verifyToken();

    return () => {
      active = false;
    };
  }, [hasToken, token]);

  const submitRequest = handleSubmit(async ({ email }) => {
    setIsRequestPending(true);
    try {
      const result = await requestResetPassword(email);
      if (!result.ok) {
        throw new Error(result.message ?? t('AUTH_RESET_PASSWORD_REQUEST_FAILED'));
      }

      setRequestSubmitted(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('AUTH_RESET_PASSWORD_REQUEST_FAILED');
      toast.error(message);
    } finally {
      setIsRequestPending(false);
    }
  });

  const submitCompletion = async ({ password }: { password: string }) => {
    setIsCompletionPending(true);
    try {
      const result = await completeResetPassword(token, password);
      if (!result.ok) {
        throw new Error(result.message ?? t('AUTH_RESET_PASSWORD_COMPLETE_FAILED'));
      }

      setIsCompleteSuccess(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('AUTH_RESET_PASSWORD_COMPLETE_FAILED');
      toast.error(message);
    } finally {
      setIsCompletionPending(false);
    }
  };

  if (hasToken) {
    if (tokenStatus === 'loading') {
      return (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (tokenStatus === 'invalid') {
      return (
        <div className="text-center">
          <h2 className="text-xl font-semibold text-center mb-3">{t('AUTH_RESET_PASSWORD_TITLE')}</h2>
          <p className="text-sm text-muted-foreground mb-4">{t('AUTH_RESET_PASSWORD_INVALID_LINK')}</p>
          <Button asChild intent="primary" className="w-full">
            <Link to="/login">{t('AUTH_RESET_PASSWORD_BACK_TO_LOGIN')}</Link>
          </Button>
        </div>
      );
    }

    if (isCompleteSuccess) {
      return (
        <>
          <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_RESET_PASSWORD_SUCCESS_TITLE')}</h2>
          <p className="text-sm text-muted-foreground mb-4">{t('AUTH_RESET_PASSWORD_COMPLETE_SUCCESS')}</p>
          <Button onClick={() => navigate('/login')} type="button" intent="primary" className="w-full">
            {t('AUTH_RESET_PASSWORD_BACK_TO_LOGIN')}
          </Button>
        </>
      );
    }

    return <ResetPasswordForm loading={isCompletionPending} onCancel={() => navigate('/login')} onSubmit={submitCompletion} />;
  }

  if (requestSubmitted) {
    return (
      <>
        <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_RESET_PASSWORD_SUCCESS_TITLE')}</h2>
        <p className="text-sm text-muted-foreground mb-4">{t('AUTH_RESET_PASSWORD_REQUEST_SUCCESS')}</p>
        <Button onClick={() => navigate('/login')} type="button" intent="primary" className="w-full">
          {t('AUTH_RESET_PASSWORD_BACK_TO_LOGIN')}
        </Button>
      </>
    );
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_RESET_PASSWORD_TITLE')}</h2>
      <p className="text-sm text-muted-foreground mb-4">{t('AUTH_RESET_PASSWORD_REQUEST_DESCRIPTION')}</p>
      <form onSubmit={submitRequest}>
        <Input
          {...register('email')}
          name="email"
          type="email"
          className="mb-3"
          label={t('AUTH_FORM_EMAIL')}
          placeholder={t('AUTH_FORM_EMAIL_PLACEHOLDER')}
          error={errors.email?.message}
          disabled={isRequestPending}
        />
        <Button loading={isRequestPending} type="submit" intent="primary" className="w-full mb-3">
          {t('AUTH_RESET_PASSWORD_REQUEST_SUBMIT')}
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/login">{t('AUTH_RESET_PASSWORD_BACK_TO_LOGIN')}</Link>
        </Button>
      </form>
    </>
  );
};
