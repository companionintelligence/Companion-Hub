import net from 'node:net';

import { resolveBrowserHost } from './browser-host';

/**
 * Construction of the Hub's own browser-reachable origins.
 *
 * The Hub is reachable two ways, and the memory-connect flow needs to name both:
 *
 *  - **Public** — its Traefik/tunnel route, `https://<hubSubdomain>.<domain>`.
 *    This is what {@link buildHubPublicOrigin} returns, and it MUST stay
 *    byte-identical to the `CI_HUB_ORIGINS` value injected into ci-memory (see
 *    `AppHelpers`), because ci-memory allowlists the connect return URL against it.
 *  - **Local** — its LAN address, `http://<internalIp>:<port>`, served by the same
 *    gateway. Reachable whenever the browser is on the appliance's network, and
 *    unaffected by tunnel health — which is the whole point of offering it as a
 *    fallback when the public route is down.
 *
 * These were previously rebuilt inline in three places (`MemoryConnectService`,
 * `AuthController`, `AppHelpers`), each with its own copy of the
 * `domain === 'example.com'` sentinel check. Centralised here so a change to what
 * counts as "provisioned" cannot apply to some call sites and not others.
 */

/**
 * Placeholder domain shipped in the default config. An appliance still carrying
 * it has never been registered, so it has no public origin — treated exactly the
 * same as a missing domain rather than producing `https://hub-x.example.com`.
 */
const UNPROVISIONED_DOMAIN = 'example.com';

/**
 * Domain used by the local/E2E stack. It resolves only on the developer's own
 * machine, so it is a valid *local* origin but never a public one.
 */
const LOCAL_DEV_DOMAIN = 'ci.localhost';

/** Hostname suffixes that are private by construction (mDNS / split-horizon LAN names). */
const PRIVATE_HOST_SUFFIXES = ['.local', '.lan', '.internal', '.home', '.localdomain'];

/**
 * The Hub's public origin (`https://<hubSubdomain>.<domain>`), or null when this
 * appliance has no provisioned public route — because it is not registered with
 * an organization (no `hubSubdomain`), or its domain is still the unprovisioned
 * placeholder.
 *
 * Returning null is meaningful, not an error: it is how a local-only Hub reports
 * "there is no public address here", which the connect surfaces read as "do not
 * offer a public launcher" rather than as a failure.
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
 * The Hub's LAN origin (`http://<internalIp>:<port>`), or null when no usable
 * internal address is configured.
 *
 * `http`, not `https`: the appliance gateway terminates TLS only for the public
 * route, so the LAN address is served plain. Port 80 is omitted so the origin
 * matches what a browser reports for `http://192.168.1.5/` — an origin string
 * with a redundant `:80` would fail every `URL.origin` comparison it is used in.
 *
 * The host goes through {@link resolveBrowserHost}, so a listen-all `INTERNAL_IP`
 * (`0.0.0.0` / `::`) collapses to loopback rather than producing an address no
 * browser can connect to.
 */
export function buildHubLocalOrigin(input: { internalIp?: string | null; port?: number | null }): string | null {
  const host = resolveBrowserHost(input.internalIp);

  if (!host) {
    return null;
  }

  const port = input.port ?? 80;

  return port === 80 ? `http://${host}` : `http://${host}:${port}`;
}

/**
 * Whether a hostname is private — i.e. only reachable from the appliance's own
 * network. Used to decide whether a caller that reached the Hub on this host
 * could also reach the Hub's LAN origin, and therefore whether offering the local
 * launcher would help them or strand them.
 *
 * Covers loopback, RFC1918 / CGNAT / link-local IPv4, IPv6 loopback + unique-local
 * + link-local, and the conventional private hostname suffixes. Anything else —
 * including any public IP or FQDN — is treated as NOT private, so the local
 * launcher is withheld by default rather than offered to someone who cannot use it.
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

/**
 * RFC1918 (10/8, 172.16/12, 192.168/16) plus loopback (127/8), link-local
 * (169.254/16) and CGNAT (100.64/10) — the ranges an appliance's `INTERNAL_IP`
 * realistically falls in. Split out so {@link isPrivateHostname} stays readable.
 */
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

/**
 * Whether `domain` is the local/E2E development domain. Exported so the tunnel
 * health probe can classify such an appliance as "no tunnel by design" instead of
 * repeatedly probing an origin that only resolves on a developer's machine.
 */
export function isLocalDevDomain(domain?: string | null): boolean {
  return domain?.trim() === LOCAL_DEV_DOMAIN;
}
