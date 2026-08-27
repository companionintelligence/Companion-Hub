import { getEffectiveExposureMode, type AppFormHostPortFields } from './app-exposure.helpers';

export type AppPublicRoutingSnapshot = AppFormHostPortFields & {
  localSubdomain?: string | null;
  publicDomain?: string | null;
  exposed?: boolean | null;
  domain?: string | null;
};

/** True when this app should participate in CI-Cloud tunnel/DNS sync. */
export function publishesCloudflarePublicRoute(snapshot: AppFormHostPortFields): boolean {
  return getEffectiveExposureMode(snapshot) === 'cloudflare' || Boolean(snapshot.exposedLocal);
}

/**
 * True when this app will actually EMIT a public identity into its compose env.
 *
 * Deliberately narrower than {@link publishesCloudflarePublicRoute}, which is
 * about what gets sent to CI-Cloud. `generateEnvFile` only sets `isExposed` (and
 * therefore only writes `APP_PUBLIC_URL` / `APP_PUBLIC_HOSTNAME`, and only
 * applies a custom-domain override) for `exposedLocal && !openPort` — an app on
 * an open host port gets no Traefik router at all.
 *
 * Binding a custom domain to an app outside this set would store the hostname,
 * raise a "restart required" badge, and then change nothing on the restart,
 * while the UI advertised an address the container had never been told about.
 */
export function canServeOnCustomDomain(snapshot: AppFormHostPortFields): boolean {
  return Boolean(snapshot.exposedLocal) && !snapshot.openPort;
}

export function resolveRoutingSubdomain(subdomain: string | null | undefined, appName: string, appStoreSlug: string): string {
  return subdomain?.trim() || `${appName}-${appStoreSlug}`;
}

/**
 * Returns true when a config save changes the public hostname/subdomain CI-Cloud
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
