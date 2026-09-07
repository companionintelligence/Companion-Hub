import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { openAuthInSystemBrowser } from '@/lib/helpers/open-auth-browser';
import { zodResolver } from '@hookform/resolvers/zod';
import type React from 'react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import z from 'zod';

type FormValues = { email: string; password: string };

const schema = z.object({
  email: z.string().email(),
  password: z.string(),
});

interface IProps {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
  loginType: string;
  portalSsoHref?: string;
  portalAccountEmail?: string | null;
  /** Native app: keep this window mounted and finish SSO via cihub:// / cihub-dev://. */
  openPortalSsoExternally?: boolean;
}

export const LoginForm: React.FC<IProps> = ({ loading, onSubmit, loginType, portalSsoHref, portalAccountEmail, openPortalSsoExternally = false }) => {
  const { t } = useTranslation();
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: portalAccountEmail ?? '', password: '' },
  });

  useEffect(() => {
    if (portalAccountEmail) {
      setValue('email', portalAccountEmail);
    }
  }, [portalAccountEmail, setValue]);

  const watchEmail = watch('email');
  const watchPassword = watch('password');

  const isDisabled = !watchEmail || !watchPassword;

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">{t('AUTH_LOGIN_TITLE', { type: loginType })}</h2>

      {portalSsoHref ? (
        <div className="mb-4">
          {openPortalSsoExternally ? (
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full text-sm font-semibold"
              onClick={() => {
                void openAuthInSystemBrowser(portalSsoHref);
              }}
            >
              {portalAccountEmail
                ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
                : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')}
            </Button>
          ) : (
            <Button asChild variant="outline" className="h-10 w-full text-sm font-semibold">
              <a href={portalSsoHref}>
                {portalAccountEmail
                  ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
                  : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')}
              </a>
            </Button>
          )}
          {/* The hint has to follow the branch above. Desktop signs in via the
              <a href> IN THE APP (hub-auth-flow.ts, desktop-hub-sso), so telling
              the user it opens their browser described the mobile flow and, once
              the same-origin interception bug was fixed, was simply untrue. */}
          <div className="text-xs text-muted-foreground text-center mt-2">
            {t(openPortalSsoExternally ? 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT' : 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP')}
          </div>
          <div className="my-4 h-px bg-border" />
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground text-center mb-4">{t('AUTH_LOGIN_COMPANION_ACCOUNT_EMAIL_HINT')}</p>

      <form onSubmit={handleSubmit(onSubmit)}>
        <Input
          {...register('email')}
          name="email"
          label={t('AUTH_FORM_EMAIL')}
          error={errors.email?.message}
          disabled={loading}
          type="email"
          className="mb-3"
          placeholder={t('AUTH_FORM_EMAIL_PLACEHOLDER')}
        />
        <PasswordInput
          {...register('password')}
          name="password"
          label={t('COMMON_PASSWORD')}
          error={errors.password?.message}
          disabled={loading}
          className="mb-3 password-input"
          placeholder={t('AUTH_FORM_PASSWORD_PLACEHOLDER')}
        />
        <div className="mt-4">
          <Button disabled={isDisabled} loading={loading} type="submit" intent="primary" className="w-full">
            {t('COMMON_LOGIN')}
          </Button>
        </div>
        <div className="text-sm text-muted-foreground text-center mt-3">
          <Link to="/reset-password">{t('AUTH_FORM_FORGOT')}</Link>
        </div>
      </form>
    </>
  );
};
