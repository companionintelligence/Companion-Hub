import { client } from '@/api-client/client.gen';
import { hubAuthFlowPolicy, resolveHubAuthFlow } from '@/lib/hub-auth-flow';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { getHubBaseUrlSync, isMobileClient, usesCloudConnect } from '@/lib/mobile-connection';
import { forgetPortalAccountEmail, resolvePortalSessionHint } from '@/lib/portal-session-hint';
import { buildPortalSsoStartUrl } from '@/lib/portal-sso-url';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openPortalSignInOutsideApp } from '../helpers/open-portal-sign-in';

/** How often the page asks again while Portal looks unreachable. Only then: a reachable answer stops it. */
export const PORTAL_RECHECK_INTERVAL_MS = 10_000;

/**
 * What the CI Account button needs: where its sign-in starts, whether this Hub can reach Portal
 * and which Portal account it is likely to sign in as.
 *
 * `/login` and `/register` both offer it. A paired Hub with no operator yet opens on `/register`.
 * Whoever paired it already has a CI Account, so that page needs the same way in (#2059).
 */
export function usePortalSignIn(redirectUrl: string | null) {
  const { t } = useTranslation();
  const [portalAccountEmail, setPortalAccountEmail] = useState<string | null>(null);
  const [portalReachable, setPortalReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const hint = await resolvePortalSessionHint();
      if (!cancelled) {
        setPortalReachable(hint.portalReachable);
        if (hint.email) {
          setPortalAccountEmail(hint.email);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Keep asking while Portal looks unreachable. The answer used to be read once, on load, so a Hub
   * opened before its network was up kept the CI Account button off until the page was reloaded,
   * even with Portal back (#2061). Checked again on a timer and when the browser says it is online.
   */
  useEffect(() => {
    if (portalReachable) {
      return;
    }
    let cancelled = false;

    const recheck = async () => {
      const hint = await resolvePortalSessionHint();
      if (cancelled || !hint.portalReachable) {
        return;
      }
      setPortalReachable(true);
      if (hint.email) {
        setPortalAccountEmail(hint.email);
      }
    };

    const timer = setInterval(() => void recheck(), PORTAL_RECHECK_INTERVAL_MS);
    const onOnline = () => void recheck();
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [portalReachable]);

  const isMobile = isMobileClient();
  const remoteHubUrl = getHubBaseUrlSync();
  const isTauriDesktop = isTauriDesktopApp();
  const authFlow = resolveHubAuthFlow({
    usesCloudConnect: usesCloudConnect(),
    remoteHubUrl,
    isTauriDesktop,
  });
  const authPolicy = hubAuthFlowPolicy(authFlow);

  const portalSsoHref = authPolicy.usesHubPortalSso
    ? buildPortalSsoStartUrl({
        remoteHubUrl,
        isTauriDesktop,
        isMobileClient: isMobile,
        configuredApiBaseUrl: client.getConfig().baseUrl,
        pageOrigin: window.location.origin,
        redirectUrl,
      })
    : undefined;

  const switchAccount = () => {
    forgetPortalAccountEmail();
    setPortalAccountEmail(null);
    if (!portalSsoHref) {
      return;
    }
    if (authPolicy.openHubSsoInSystemBrowser) {
      openPortalSignInOutsideApp(portalSsoHref, t('COMMON_AN_ERROR_OCCURRED'));
      return;
    }
    window.location.assign(portalSsoHref);
  };

  return { authPolicy, isMobile, portalSsoHref, portalAccountEmail, portalReachable, switchAccount };
}
