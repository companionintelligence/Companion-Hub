import { useDesktopPortalAuth } from '@/hooks/use-desktop-portal-auth';

/** Mounts globally so portal SSO deep links work on any route (not only /login). */
export function DesktopPortalAuthListener() {
  useDesktopPortalAuth();
  return null;
}
