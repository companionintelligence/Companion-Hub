import { publishesPublicWebRoute, resolveRoutingSubdomain, storedExposureForm } from '@ci-hub/common/types';
import type { AppFormHostPortFields } from './app-exposure.helpers';

export type AppPublicRoutingSnapshot = AppFormHostPortFields & {
  localSubdomain?: string | null;
  publicDomain?: string | null;
  exposed?: boolean | null;
  domain?: string | null;
};

/**
 * True when this app should participate in Companion Portal tunnel/DNS sync.
 *
 * The same rule compose builds the tunnel router under (`publishesPublicWebRoute`). Judge an
 * installed app by {@link publicRoutingSnapshotOf}, not by its row columns.
 */
export function publishesCloudflarePublicRoute(snapshot: AppFormHostPortFields): boolean {
  return publishesPublicWebRoute(snapshot);
}

/**
 * An app row with its exposure read from the stored install form, which compose is generated
 * from. The row's `exposed_local` defaults to true for an exposable app installed without
 * exposure settings, so judging the row itself published a route that compose never built.
 */
export function publicRoutingSnapshotOf<T extends AppPublicRoutingSnapshot & { config?: unknown }>(app: T): T {
  return { ...app, ...storedExposureForm(app) };
}

/**
 * Whether the tunnel route puts the Hub login (`ci-hub@file`) in front of the app.
 *
 * The form's `enableAuth` when it holds one. When it does not, an open host port turns the login
 * on. Compose once skipped the tunnel route for apps on an open host port (#678's gate), and most
 * of them never chose a login, because the queue sets `openPort` to true for any API or MCP install
 * that left it out. Without this default, the next Hub upgrade (`restartRunningApps`) would put
 * those apps on the internet with no login, CI-OpenClaw among them, whose `/` hands out a gateway
 * token. The install and settings dialogs also turn the toggle on by default.
 */
export function requiresHubLoginOnPublicRoute(form: { enableAuth?: boolean; openPort?: boolean }): boolean {
  return form.enableAuth ?? Boolean(form.openPort);
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
