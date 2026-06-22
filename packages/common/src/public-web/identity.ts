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
