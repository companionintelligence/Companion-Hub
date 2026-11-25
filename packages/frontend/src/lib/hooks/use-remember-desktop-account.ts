import { useEffect } from 'react';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { rememberPortalAccountEmail } from '@/lib/portal-session-hint';

/**
 * Remembers which account this desktop window is signed in as, so its sign-in page can offer "Sign in
 * as" that account after the session ends some other way, such as a password change (#2549). Read
 * from the signed-in user, so every way of signing in counts. Browsers keep nothing, since one can be
 * shared and its sign-in page would name whoever used it last.
 */
export function useRememberDesktopAccount(email: string | null | undefined): void {
  useEffect(() => {
    const address = email?.trim();
    if (address && isTauriDesktopApp()) {
      rememberPortalAccountEmail(address);
    }
  }, [email]);
}
