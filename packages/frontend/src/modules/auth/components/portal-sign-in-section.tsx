import { Button } from '@/components/ui/Button';
import { AuthSessionCancelledError, openAuthSession } from '@/lib/helpers/open-auth-browser';
import type React from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

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
   * outlined alternative, is disabled while Portal is unreachable, and ends in a
   * divider. Phones have no form: the in-app sheet is the only way in.
   */
  withPasswordForm?: boolean;
}

/** The "Sign in using your CI Account" button, its hint and the account switcher. */
export const PortalSignInSection: React.FC<IProps> = ({
  portalSsoHref,
  portalAccountEmail,
  openPortalSsoExternally = false,
  onSwitchAccount,
  portalReachable = true,
  withPasswordForm = true,
}) => {
  const { t } = useTranslation();

  return (
    <div className="mb-4">
      {openPortalSsoExternally ? (
        <Button
          type="button"
          variant={withPasswordForm ? 'outline' : undefined}
          intent={withPasswordForm ? undefined : 'primary'}
          className="h-10 w-full text-sm font-semibold"
          disabled={withPasswordForm && !portalReachable}
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
          {portalAccountEmail ? t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS', { email: portalAccountEmail }) : t('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')}
        </Button>
      ) : (
        <Button
          asChild={portalReachable || !withPasswordForm}
          variant="outline"
          className="h-10 w-full text-sm font-semibold"
          disabled={withPasswordForm && !portalReachable}
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
          withPasswordForm
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
      {withPasswordForm ? <div className="my-4 h-px bg-border" /> : null}
    </div>
  );
};
