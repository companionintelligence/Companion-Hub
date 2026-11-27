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
 *
 * Null, so the gateway answers every Host, when the operator opened the app's port on the network:
 * a browser elsewhere then reaches it under whatever name the LAN gives this computer, which the Hub
 * cannot know. A list missing one of those names would lock that browser out, which is worse than no
 * list. On 127.0.0.1 only (the default) a browser on this computer uses 127.0.0.1 or localhost.
 */
export const GATEWAY_ALLOWED_HOSTS_ENV_KEY = 'HUB_GATEWAY_ALLOWED_HOSTS';

/** Every Tailscale name: a leading dot is a suffix to the gateway. */
export const TAILNET_HOST_SUFFIX = '.ts.net';

/** Docker's name for the host, from inside a container. */
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

export interface GatewayAllowedHostsInput {
  /** Whether compose publishes the app's main port on every interface (`publishesMainPortOnNetwork`). */
  portOnNetwork: boolean;
  /** The tunnel's Host for the app, when it has a Public web route. */
  originHostname?: string;
  /** Whether the app is on Private VPN, whose Traefik router answers `<app>.<store>`. */
  privateVpn: boolean;
  appName: string;
  appStoreId: string;
}

/** The value of {@link GATEWAY_ALLOWED_HOSTS_ENV_KEY}, or null when it must be left unset. */
export function gatewayAllowedHosts(input: GatewayAllowedHostsInput): string[] | null {
  if (input.portOnNetwork) {
    return null;
  }

  const hosts = [
    input.originHostname?.trim().toLowerCase(),
    input.privateVpn ? `${input.appName}.${input.appStoreId}`.toLowerCase() : undefined,
    DOCKER_HOST_ALIAS,
    TAILNET_HOST_SUFFIX,
  ].filter((host): host is string => Boolean(host));

  return [...new Set(hosts)];
}
