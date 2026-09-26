import { resolveRoutingSubdomain } from '@ci-hub/common/types';
import { getEffectiveExposureMode, type AppFormHostPortFields } from './app-exposure.helpers';

export type AppPublicRoutingSnapshot = AppFormHostPortFields & {
  localSubdomain?: string | null;
  publicDomain?: string | null;
  exposed?: boolean | null;
  domain?: string | null;
};

/** True when this app should participate in Companion Portal tunnel/DNS sync. */
export function publishesCloudflarePublicRoute(snapshot: AppFormHostPortFields): boolean {
  return getEffectiveExposureMode(snapshot) === 'cloudflare' || Boolean(snapshot.exposedLocal);
}

/**
 * True when this app will actually EMIT a public identity into its compose env.
 *
 * Deliberately narrower than {@link publishesCloudflarePublicRoute}, which is
 * about what gets sent to Companion Portal. `generateEnvFile` only sets `isExposed` (and
 * therefore only writes `APP_PUBLIC_URL` / `APP_PUBLIC_HOSTNAME`, and only
 * applies a custom-domain override) for `exposedLocal && !openPort`. An app on
 * an open host port still gets its tunnel router (`prepareAppComposeDir`), but
 * its env names the LAN address, so it never learns a custom hostname.
 *
 * Binding a custom domain to an app outside this set would store the hostname,
 * raise a "restart required" badge, and then change nothing on the restart,
 * while the UI advertised an address the container had never been told about.
 */
export function canServeOnCustomDomain(snapshot: AppFormHostPortFields): boolean {
  return Boolean(snapshot.exposedLocal) && !snapshot.openPort;
}

// Defined in @ci-hub/common so the frontend builds the same hostname the tunnel sync publishes.
export { resolveRoutingSubdomain };

/**
 * Returns true when a config save changes the public hostname/subdomain Companion Portal
 * publishes, so the previous DNS record must be released before the new one is created.
 */
export function didPublicRoutingIdentityChange(
  before: AppPublicRoutingSnapshot,
  after: AppPublicRoutingSnapshot,
  appName: string,
  appStoreSlug: string,
): boolean {
  const wasPublished = publishesCloudflarePublicRoute(before);
  const willPublish = publishesCloudflarePublicRoute(after);

  if (!wasPublished && !willPublish) {
    return false;
  }

  if (wasPublished !== willPublish) {
    return true;
  }

  const oldSubdomain = resolveRoutingSubdomain(before.localSubdomain, appName, appStoreSlug);
  const newSubdomain = resolveRoutingSubdomain(after.localSubdomain, appName, appStoreSlug);
  const oldPublicDomain = before.publicDomain?.trim() || null;
  const newPublicDomain = after.publicDomain?.trim() || null;

  return oldSubdomain !== newSubdomain || oldPublicDomain !== newPublicDomain;
}
