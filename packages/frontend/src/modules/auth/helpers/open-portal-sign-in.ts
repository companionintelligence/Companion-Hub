import { AuthSessionCancelledError, openAuthSession } from '@/lib/helpers/open-auth-browser';
import { toast } from 'sonner';

/**
 * Open CI Account sign-in outside this window: the system browser on desktop, the in-app sheet on a phone.
 *
 * Do not discard the rejection. openAuthSession THROWS on an opener ACL or plugin failure. A bare
 * `void` turned that into a dead button with no toast, no console line and no UI change, which is
 * what made the desktop sign-in button look broken.
 */
export function openPortalSignInOutsideApp(portalSsoHref: string, errorMessage: string) {
  openAuthSession(portalSsoHref).catch((error: unknown) => {
    if (error instanceof AuthSessionCancelledError) {
      return;
    }
    console.error('login: the system opener refused the SSO URL', error);
    toast.error(errorMessage);
  });
}
