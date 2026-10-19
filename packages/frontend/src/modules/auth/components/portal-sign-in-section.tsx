import { Button } from '@/components/ui/Button';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { openPortalSignInOutsideApp } from '../helpers/open-portal-sign-in';

interface IProps {
  portalSsoHref: string;
  portalAccountEmail?: string | null;
  /** Native app: keep this window mounted and finish SSO via cihub:// / cihub-dev://. */
  openPortalSsoExternally?: boolean;
  /** Clear the sticky Portal hint and let another family member sign in. */
  onSwitchAccount?: () => void;
  /** False when this Hub cannot reach CI Portal. OIDC needs WAN; the password form does not. */
  portalReachable?: boolean;
  /**
   * An email and password form follows the button. The button is then the
   * outlined alternative. It is disabled while Portal is unreachable and ends in a
   * divider. Phones have no form: the in-app sheet is the only way in.
   */
  withPasswordForm?: boolean;
  /**
   * The hint under a disabled button while Portal is unreachable. The default sends people to the
   * sign-in form below, which works offline for anyone who has signed in here before.
   */
  unreachableHintKey?: string;
}

/** The "Sign in using your CI Account" button, its hint and the account switcher. */
export const PortalSignInSection: React.FC<IProps> = ({
  portalSsoHref,
  portalAccountEmail,
  openPortalSsoExternally = false,
  onSwitchAccount,
  portalReachable = true,
  withPasswordForm = true,
  unreachableHintKey = 'AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET',
}) => {
  const { t } = useTranslation();
  const label = portalAccountEmail
    ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail })
    : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON');

  return (
    <div className="mb-4">
      {openPortalSsoExternally ? (
        <Button
          type="button"
          variant={withPasswordForm ? 'outline' : undefined}
          intent={withPasswordForm ? undefined : 'primary'}
          className="h-10 w-full text-sm font-semibold"
          disabled={withPasswordForm && !portalReachable}
          onClick={() => openPortalSignInOutsideApp(portalSsoHref, t('COMMON_AN_ERROR_OCCURRED'))}
        >
          {label}
        </Button>
      ) : (
        <Button
          asChild={portalReachable || !withPasswordForm}
          variant="outline"
          className="h-10 w-full text-sm font-semibold"
          disabled={withPasswordForm && !portalReachable}
        >
          {portalReachable ? <a href={portalSsoHref}>{label}</a> : label}
        </Button>
      )}
      {/* The hint has to follow the branch above: the <a href> branch is a
          plain browser already ON the Hub, which navigates in place. Every
          native shell takes the button branch, phone and desktop alike.
          Phones present an in-app browser sheet. Desktop opens the system browser. */}
      <div className="text-xs text-muted-foreground text-center mt-2">
        {t(
          withPasswordForm
            ? portalReachable
              ? openPortalSsoExternally
                ? 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT'
                : 'AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP'
              : unreachableHintKey
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
      {withPasswordForm ? <div className="my-4 h-px bg-border" /> : null}
    </div>
  );
};
