import net from 'node:net';

import { resolveBrowserHost } from './browser-host';

/**
 * Builds browser-reachable Hub origins from one definition of public, local, and
 * Private VPN addresses. Public origins must match `CI_HUB_ORIGINS`, which Memory
 * uses to allowlist connect return URLs.
 */

/** The default domain must not produce a public origin before registration. */
const UNPROVISIONED_DOMAIN = 'example.com';

/** The local/E2E domain is valid only as a developer-machine origin. */
const LOCAL_DEV_DOMAIN = 'ci.localhost';

/**
 * These suffixes identify local-only hosts. RFC 6761 reserves `.localhost` for
 * loopback, so its classification must match {@link isLoopbackPortalHost}.
 */
const PRIVATE_HOST_SUFFIXES = ['.local', '.lan', '.internal', '.home', '.localdomain', '.localhost'];

/**
 * A `.ts.net` host arrives through the Private VPN; local gateways and public
 * tunnels do not produce this suffix.
 */
const TAILNET_HOST_SUFFIX = '.ts.net';

/**
 * The zone this Hub is published in: the `DOMAIN` its Portal paired it into, with an operator
 * `userSettings` override on top. Shared so that sign-in, edge SSO and forward auth cannot
 * disagree about the Hub's own hostname.
 *
 * Two limits worth knowing before reaching for it. The override rung is process-lifetime only —
 * `configure()` seeds `userSettings.domain` from `DOMAIN` and `generateSystemEnvFile` resolves
 * `DOMAIN` with no settings rung, unlike `LOCAL_DOMAIN` beside it. And tunnel health,
 * memory-connect and the `CI_HUB_ORIGINS` written into app environments still read
 * `config.domain` alone on purpose: they must stay byte-identical to each other.
 */
export function resolveHubPublicDomainRoot(config: { domain?: string | null; userSettings?: { domain?: string | null } | null }): string {
  return config.userSettings?.domain?.trim() || config.domain?.trim() || '';
}

/** The local root the appliance's LAN hostnames are built with, on the same precedence. */
export function resolveHubLocalDomainRoot(config: { localDomain?: string | null; userSettings?: { localDomain?: string | null } | null }): string {
  return config.userSettings?.localDomain?.trim() || config.localDomain?.trim() || '';
}

/**
 * Builds the Hub's public origin, or returns null before organization registration.
 * Null prevents connect surfaces from offering an unusable public launcher.
 */
export function buildHubPublicOrigin(input: { hubSubdomain?: string | null; domain?: string | null }): string | null {
  const hubSubdomain = input.hubSubdomain?.trim();
  const domain = input.domain?.trim();

  if (!hubSubdomain || !domain || domain === UNPROVISIONED_DOMAIN) {
    return null;
  }

  return `https://${hubSubdomain}.${domain}`;
}

/**
 * Builds the Hub's LAN origin, or returns null when no internal address is configured.
 * The LAN gateway uses HTTP, and port 80 is omitted to match browser origins. An
 * explicit wildcard bind resolves to loopback, but a missing address does not.
 */
export function buildHubLocalOrigin(input: { internalIp?: string | null; port?: number | null }): string | null {
  if (!input.internalIp?.trim()) {
    return null;
  }

  const host = resolveBrowserHost(input.internalIp);
  const port = input.port ?? 80;

  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

/**
 * Builds the Private VPN origin only when Tailscale Serve can provide HTTPS. Serve
 * terminates TLS on port 443 for the node FQDN; otherwise null prevents advertising
 * an unreachable launcher.
 */
export function buildHubTailnetOrigin(input: { connected?: boolean; httpsAvailable?: boolean; nodeFqdn?: string | null }): string | null {
  if (!input.connected || !input.httpsAvailable) {
    return null;
  }

  const nodeFqdn = input.nodeFqdn?.trim().replace(/\.+$/, '');

  if (!nodeFqdn) {
    return null;
  }

  return `https://${nodeFqdn.toLowerCase()}`;
}

/** Canonical prefix for Tailscale's `fd7a:115c:a1e0::/48` range. */
const TAILNET_IPV6_PREFIX = 'fd7a:115c:a1e0:';

/**
 * Reports whether a host is a MagicDNS name or Tailscale-assigned IP. Callers
 * classify tailnet hosts before {@link isPrivateHostname}; Tailscale ranges are
 * private but can reach the Private VPN origin without reaching the appliance LAN.
 */
export function isTailnetHostname(hostname: string | null | undefined): boolean {
  const host = hostname
    ?.trim()
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/\.+$/, '');

  if (!host) {
    return false;
  }

  if (host.endsWith(TAILNET_HOST_SUFFIX)) {
    return true;
  }

  const ipVersion = net.isIP(host);

  if (ipVersion === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number);

    return first === 100 && second >= 64 && second <= 127;
  }

  if (ipVersion === 6) {
    return host.startsWith(TAILNET_IPV6_PREFIX);
  }

  return false;
}

/**
 * Reports whether a host is reachable only from a private network. Unknown and
 * public hosts default to false so callers do not receive an unusable LAN launcher.
 */
export function isPrivateHostname(hostname: string | null | undefined): boolean {
  const host = hostname
    ?.trim()
    .toLowerCase()
    .replace(/^\[|]$/g, '');

  if (!host) {
    return false;
  }

  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  const ipVersion = net.isIP(host);

  if (ipVersion === 4) {
    return isPrivateIpv4(host);
  }

  if (ipVersion === 6) {
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local.
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }

  return false;
}

/** Matches private IPv4 ranges that can identify an appliance's internal address. */
function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first = 0, second = 0] = octets;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/** Identifies local/E2E domains so tunnel checks do not probe a developer-only origin. */
export function isLocalDevDomain(domain?: string | null): boolean {
  return domain?.trim() === LOCAL_DEV_DOMAIN;
}
