import { gatewayHostNameSchema, LAN_HOST_SUFFIXES } from '@ci-hub/common/schemas';
import psl from 'psl';

/**
 * The Host names an app's gateway may answer to, passed as `HUB_GATEWAY_ALLOWED_HOSTS`. First-party
 * Companion Memory maps it to its gateway's `GATEWAY_ALLOWED_HOSTS`, which answers any other name
 * with 421: the guard against DNS rebinding, where a page on any site points its own name at the
 * app's address and then talks to it as same-origin under that name.
 *
 * The gateway itself always passes IP addresses, `localhost`, `*.localhost` and single-label names.
 * The last covers how the Hub's other apps reach Memory (`http://ci-memory:8642`, `MEMORY_LINK_ALIAS`)
 * and the stack's own containers by service name. The Hub reaches it at its container's IP address
 * (`MemoryProviderResolver.internalUrl`). What is left is listed here:
 *
 * - The tunnel's Host for the app's Public web route (`cloudflareOriginHostnameFor`): cloudflared
 *   sends it, Traefik's router names it and passes it on. A custom domain's ingress rule sends the
 *   same Host. When the name changes (a new device or organization name, a new subdomain), the app is
 *   recreated and this list with it (`OriginHostRefreshService`, a settings change).
 * - Every name under `ts.net`: Tailscale Serve passes on the Host a tailnet browser used, the node's
 *   name on the per-port addresses or the Tailscale Service's own. Both change with the tailnet and
 *   the Service label, which a restart would not follow, and nobody outside Tailscale can point a
 *   `ts.net` name at an address of their choosing.
 * - The Private VPN router's own name (`<app>.<store>`, `TraefikLabelsBuilder.addTailscaleLabels`).
 * - `host.docker.internal`, what a container on this computer may use for the app's host port.
 * - When the operator opened the app's port on the network, every name under the LAN suffixes
 *   ({@link LAN_HOST_SUFFIXES}): a browser elsewhere uses whatever name the LAN gives this computer,
 *   and a router's or mDNS name ends in one of those, or has no dot at all, which always passes. A
 *   page on another site still can't name one. On 127.0.0.1 only (the default) a browser on this
 *   computer uses 127.0.0.1 or localhost.
 * - The operator's own names (`gatewayHostNames`, "More names Memory answers to"), in every mode: a
 *   router that names this computer `kyle-pc.fritz.box`, a DNS name of the operator's own.
 */
export const GATEWAY_ALLOWED_HOSTS_ENV_KEY = 'HUB_GATEWAY_ALLOWED_HOSTS';

/** Every Tailscale name: a leading dot is a suffix to the gateway. */
export const TAILNET_HOST_SUFFIX = '.ts.net';

/** Docker's name for the host, from inside a container. */
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

export interface GatewayAllowedHostsInput {
  /** Whether compose publishes the app's main port on every interface (`publishesMainPortOnNetwork`). */
  portOnNetwork: boolean;
  /** The stored form's `gatewayHostNames`; anything {@link gatewayHostNameRefusal} refuses is left out. */
  operatorNames?: unknown;
  /** The tunnel's Host for the app, when it has a Public web route. */
  originHostname?: string;
  /** Whether the app is on Private VPN, whose Traefik router answers `<app>.<store>`. */
  privateVpn: boolean;
  appName: string;
  appStoreId: string;
}

/**
 * Why an operator's name can't be added ({@link gatewayAllowedHosts}), or null when it can: `invalid`,
 * not a host name or a suffix; `too-wide`, a suffix that covers names anyone can register.
 */
export type GatewayHostNameRefusal = 'invalid' | 'too-wide';

/**
 * Whether `name` may be one of the operator's names: what `gatewayHostNameSchema` takes, and, for a
 * suffix, not a whole top-level domain nor any other public suffix (`.com`, `.co.uk`, `.github.io`).
 * The LAN suffixes and `.ts.net` are on the list already and always taken.
 */
export function gatewayHostNameRefusal(name: string): GatewayHostNameRefusal | null {
  const value = name.trim().toLowerCase();
  if (value === TAILNET_HOST_SUFFIX || LAN_HOST_SUFFIXES.includes(value)) {
    return null;
  }
  if (/^\.[a-z0-9-]+$/.test(value)) {
    return 'too-wide';
  }
  if (!gatewayHostNameSchema.safeParse(value).success) {
    return 'invalid';
  }
  if (!value.startsWith('.')) {
    return null;
  }
  const suffix = psl.parse(value.slice(1));
  return 'error' in suffix || (suffix.listed && suffix.domain === null) ? 'too-wide' : null;
}

/** The operator's names the gateway may take, lower case, once each; anything else is left out. */
function operatorHostNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((name): name is string => typeof name === 'string' && gatewayHostNameRefusal(name) === null)
    .map((name) => name.trim().toLowerCase());
}

/** The value of {@link GATEWAY_ALLOWED_HOSTS_ENV_KEY}. */
export function gatewayAllowedHosts(input: GatewayAllowedHostsInput): string[] {
  const hosts = [
    input.originHostname?.trim().toLowerCase(),
    input.privateVpn ? `${input.appName}.${input.appStoreId}`.toLowerCase() : undefined,
    DOCKER_HOST_ALIAS,
    TAILNET_HOST_SUFFIX,
    ...(input.portOnNetwork ? LAN_HOST_SUFFIXES : []),
    ...operatorHostNames(input.operatorNames),
  ].filter((host): host is string => Boolean(host));

  return [...new Set(hosts)];
}
