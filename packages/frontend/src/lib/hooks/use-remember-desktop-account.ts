import { useEffect } from 'react';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { rememberPortalAccountEmail } from '@/lib/portal-session-hint';

/**
 * Remembers which account this desktop window is signed in as. When the session ends some other way
 * (the CI Account password changed, a sign-out from a browser), the window's sign-in page offers
 * "Sign in as" that account again with a "Not …?" link under it.
 *
 * The desktop app's presence heartbeat used to write it, and the PKCE sign-in retired the heartbeat,
 * so nothing did: the sign-in page always opened blank (#2549). Taken from the signed-in user here
 * rather than from each sign-in, so the password form, the CI Account button and a window that was
 * already signed in all count.
 *
 * Only the desktop app. A browser can be shared, and its sign-in page would name the last person who
 * used it.
 */
export function useRememberDesktopAccount(email: string | null | undefined): void {
  useEffect(() => {
    const address = email?.trim();
    if (address && isTauriDesktopApp()) {
      rememberPortalAccountEmail(address);
    }
  }, [email]);
}
