export interface PublicWebIdentity {
  /** User-facing app slug only (e.g. "nextcloud"). */
  appSubdomain: string;
  /** Root public zone (e.g. "companionintelligence.com" or "my.lifescope.io"). */
  publicDomainRoot: string;
  /** Full FQDN for Traefik routing and tunnel sync. */
  hostname: string;
  /** HTTPS URL for the app. */
  publicUrl: string;
  /** Public DNS hostname for the app; distinct from the internal origin Host header. */
  publicDnsHostname: string;
}

export interface BuildPublicWebIdentityInput {
  appSubdomain: string;
  hubSubdomain?: string | null;
  orgSlug?: string | null;
  publicDomainRoot: string;
}

export interface ResolvePublicDomainRootInput {
  selectedPublicDomain?: string | null;
  envDomain?: string | null;
  configDomain: string;
}

export interface BuildOriginServerNameInput {
  appSubdomain: string;
  hubSubdomain?: string | null;
  orgSlug?: string | null;
  localDomain: string;
}

/**
 * Mirror CI-Portal subdomain sanitization so Hub sync payloads match CI-Cloud expectations.
 */
export function sanitizeAppSubdomain(subdomain: string): string {
  let clean = subdomain;
  if (clean.includes('.')) {
    clean = clean.split('.')[0] ?? clean;
  }
  return clean
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The subdomain an app routes on: the operator's `localSubdomain` when one is
 * set, otherwise `<appName>-<appStoreSlug>`.
 *
 * This is the label Companion Portal publishes and the one every public
 * hostname for the app is built from, so anything that shows or compares an
 * app's public address must start here. The bare app name is NOT a fallback:
 * an app installed without a `localSubdomain` (API, MCP, fleet and restore
 * installs) is served at `ci-hermes-ci-marketplace-…`, and a UI that dropped
 * the store slug linked to `ci-hermes-…`, a name that does not resolve.
 */
export function resolveRoutingSubdomain(subdomain: string | null | undefined, appName: string, appStoreSlug: string): string {
  return subdomain?.trim() || `${appName}-${appStoreSlug}`;
}

/** App names/slugs that collide with reserved UI routes and must be rejected. */
export const RESERVED_APP_NAMES = ['create', 'expose'];

/**
 * Derive a URL-safe app slug from a free-form display name. Unlike
 * {@link sanitizeAppSubdomain}, dots are treated like any other separator
 * (replaced with a hyphen) rather than truncating the name — a display name is
 * not a subdomain label, so "Node.js Dashboard" becomes "node-js-dashboard",
 * not "node". Returns an empty string when the name has no slug-able (ASCII
 * alphanumeric) characters.
 */
export function deriveAppSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function extractDeviceSlug(hubSubdomain: string | null | undefined, orgSlug: string): string | null {
  if (!hubSubdomain) return null;
  const withoutPrefix = hubSubdomain.replace(/^hub-/, '');
  const orgSuffix = `-${orgSlug}`;
  if (withoutPrefix.endsWith(orgSuffix)) {
    return withoutPrefix.slice(0, -orgSuffix.length) || null;
  }
  return withoutPrefix || null;
}

export function resolvePublicDomainRoot(input: ResolvePublicDomainRootInput): string {
  const userSelected = Boolean(input.selectedPublicDomain?.trim());
  let root = (input.selectedPublicDomain?.trim() || input.envDomain?.trim() || input.configDomain).trim();
  if (!userSelected && root.endsWith(`.${input.configDomain}`)) {
    root = input.configDomain;
  }
  return root;
}

export function buildFqdnSubdomain(appSubdomain: string, hubSubdomain: string | null | undefined, orgSlug: string): string {
  const cleanAppSub = sanitizeAppSubdomain(appSubdomain);
  const deviceSlug = extractDeviceSlug(hubSubdomain, orgSlug);
  if (deviceSlug && deviceSlug !== orgSlug) {
    return `${cleanAppSub}-${deviceSlug}-${orgSlug}`;
  }
  return `${cleanAppSub}-${orgSlug}`;
}

export function buildOriginServerName(input: BuildOriginServerNameInput): string {
  const localDomain = input.localDomain.trim();
  const appSubdomain = sanitizeAppSubdomain(input.appSubdomain);
  const orgSlug = input.orgSlug?.trim();

  if (!orgSlug) {
    return `${appSubdomain}.${localDomain}`;
  }

  const fqdnSubdomain = buildFqdnSubdomain(appSubdomain, input.hubSubdomain, orgSlug);
  return `${fqdnSubdomain}.${localDomain}`;
}

export function buildPublicWebIdentity(input: BuildPublicWebIdentityInput): PublicWebIdentity {
  const publicDomainRoot = input.publicDomainRoot.trim();
  const appSubdomain = sanitizeAppSubdomain(input.appSubdomain);
  const orgSlug = input.orgSlug?.trim();

  if (!orgSlug) {
    const hostname = `${appSubdomain}.${publicDomainRoot}`;
    return {
      appSubdomain,
      publicDomainRoot,
      hostname,
      publicUrl: `https://${hostname}`,
      publicDnsHostname: hostname,
    };
  }

  const fqdnSubdomain = buildFqdnSubdomain(appSubdomain, input.hubSubdomain, orgSlug);
  const hostname = `${fqdnSubdomain}.${publicDomainRoot}`;

  return {
    appSubdomain,
    publicDomainRoot,
    hostname,
    publicUrl: `https://${hostname}`,
    publicDnsHostname: hostname,
  };
}
