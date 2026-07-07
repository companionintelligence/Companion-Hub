import { useDeepLinkInstall } from '@/hooks/use-deep-link-install';

/** Mounts globally so store install deep links work on any route. */
export function DesktopInstallIntentListener() {
  useDeepLinkInstall();
  return null;
}
