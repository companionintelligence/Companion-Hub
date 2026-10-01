import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { AuthSessionCancelledError, openAuthSession } from '@/lib/helpers/open-auth-browser';
import { zodResolver } from '@hookform/resolvers/zod';
import type React from 'react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
        <div className="mb-4">
          {openPortalSsoExternally ? (
            <Button
              type="button"
              variant={allowPasswordLogin ? 'outline' : undefined}
              intent={allowPasswordLogin ? undefined : 'primary'}
              className="h-10 w-full text-sm font-semibold"
              disabled={allowPasswordLogin && !portalReachable}
              onClick={() => {
                // Do not discard the rejection. openAuthSession THROWS on
                // an opener ACL/plugin failure rather than swallowing it, so a
                // bare `void` turned that into a dead button with no toast, no
                // console line and no UI change -- the same silent-failure shape
                // that made the desktop sign-in button look broken.
                openAuthSession(portalSsoHref).catch((error: unknown) => {
                  if (error instanceof AuthSessionCancelledError) {
                    return;
                  }
                  console.error('login: the system opener refused the SSO URL', error);
                  toast.error(t('COMMON_AN_ERROR_OCCURRED'));
                });
              }}
            >
              {portalAccountEmail
                ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
                : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')}
            </Button>
          ) : (
            <Button
              asChild={portalReachable || !allowPasswordLogin}
              variant="outline"
              className="h-10 w-full text-sm font-semibold"
              disabled={allowPasswordLogin && !portalReachable}
            >
              {portalReachable ? (
                <a href={portalSsoHref}>
                  {portalAccountEmail
                    ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
                    : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')}
                </a>
              ) : portalAccountEmail ? (
                t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
              ) : (
                t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')
              )}
            </Button>
          )}
          {/* The hint has to follow the branch above: the <a href> branch is a
              plain browser already ON the Hub, which navigates in place. Every
              native shell — phone and desktop alike — takes the button branch.
              Phones present an in-app browser sheet. Desktop opens the system browser. */}
          <div className="text-xs text-muted-foreground text-center mt-2">
            {t(
              allowPasswordLogin
                ? portalReachable
                  ? openPortalSsoExternally
                    ? 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT'
                    : 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP'
                  : 'AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET'
                : 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP',
            )}
          </div>
          {portalAccountEmail && onSwitchAccount ? (
            <button
              type="button"
              data-testid="login-switch-account"
              className="mx-auto mt-1 block py-0 leading-tight text-sm text-muted-foreground underline"
              onClick={onSwitchAccount}
            >
              {t('AUTH_LOGIN_NOT_THIS_ACCOUNT', { email: portalAccountEmail })}
            </button>
          ) : null}
          {allowPasswordLogin ? <div className="my-4 h-px bg-border" /> : null}
        </div>
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
