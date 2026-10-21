import type { ToasterProps } from 'sonner';

/**
 * The pages that show the sign-in card (`AuthLayout`). In the desktop window the card's last rows,
 * the form's own button among them, sit where a bottom toast appears, and the desktop app's restart
 * notice stays until it is answered.
 */
const SIGNED_OUT_PATHS = new Set(['/login', '/register', '/reset-password', '/device-registration']);

/** Clear of the desktop window's title bar and of a phone's status bar. */
const TOP_OFFSET = 'calc(var(--titlebar-height, 0px) + var(--safe-area-top, 0px) + 16px)';

export type ToasterPlacement = Pick<ToasterProps, 'position' | 'offset' | 'mobileOffset'>;

/**
 * Where toasts go on a page. On the sign-in pages they sit at the top, over the logo, so they never
 * cover the form. Everywhere else they keep the Toaster's own place, and a toast still open when
 * the sign-in page goes moves back there with it.
 */
export function toasterPlacement(pathname: string): ToasterPlacement {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!SIGNED_OUT_PATHS.has(path)) {
    return {};
  }
  return { position: 'top-center', offset: { top: TOP_OFFSET }, mobileOffset: { top: TOP_OFFSET } };
}
