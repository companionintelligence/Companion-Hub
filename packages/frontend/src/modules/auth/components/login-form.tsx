import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { zodResolver } from '@hookform/resolvers/zod';
import type React from 'react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import z from 'zod';
import { PortalSignInSection } from './portal-sign-in-section';

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
  /** Clear the sticky Portal hint and let another family member sign in. */
  onSwitchAccount?: () => void;
  /** False when this Hub cannot reach CI Portal. OIDC needs WAN; the password form does not. */
  portalReachable?: boolean;
  /**
   * Phone sign-in is the in-app sheet only. Memory does not offer email and
   * password there, and a Hub that cannot reach Portal must not either: the
   * sheet talks to Portal from the phone.
   */
  allowPasswordLogin?: boolean;
}

export const LoginForm: React.FC<IProps> = ({
  loading,
  onSubmit,
  loginType,
  portalSsoHref,
  portalAccountEmail,
  openPortalSsoExternally = false,
  onSwitchAccount,
  portalReachable = true,
  allowPasswordLogin = true,
}) => {
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
        <PortalSignInSection
          portalSsoHref={portalSsoHref}
          portalAccountEmail={portalAccountEmail}
          openPortalSsoExternally={openPortalSsoExternally}
          onSwitchAccount={onSwitchAccount}
          portalReachable={portalReachable}
          withPasswordForm={allowPasswordLogin}
        />
      ) : null}

      {allowPasswordLogin ? (
        <>
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
      ) : null}
    </>
  );
};
