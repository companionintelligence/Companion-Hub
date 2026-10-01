import { hubNetworkName } from '@/common/constants';

export type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

interface TraefikLabelsArgs {
  internalPort: number | string;
  appId: string;
  exposureMode: ExposureMode;
  storeId: string;
  enableAuth?: boolean;
  cloudflareOriginHostname?: string;
  cloudflarePublicHostname?: string;
  localDomain?: string;
  tailscaleHostname?: string;
  httpsBackend?: boolean;
}

/** The file-provider middleware that strips visitor-set forwarded headers from tunnel requests. */
export const EDGE_HEADERS_MIDDLEWARE = 'ci-hub-edge-headers@file';

/**
 * The file-provider `errors` middleware that swaps Traefik's bare 502, 503 and 504 for the Hub's
 * "<app> is starting…" page. See `ci-hub-app-starting` in assets/traefik/dynamic/dynamic.yml.
 */
export const APP_STARTING_MIDDLEWARE = 'ci-hub-app-starting@file';

/** `traefik.http.routers.<router>.<option>`. Traefik reads option names without regard to case. */
const HTTP_ROUTER_LABEL = /^traefik\.http\.routers\.([^.]+)\.(.+)$/i;

/**
 * Ends every HTTP router in an app container's labels with {@link APP_STARTING_MIDDLEWARE}.
 *
 * Every router, whoever declared it. The ones this builder adds are only some of them: a manifest's
 * `extraLabels` can replace a router's whole middleware chain (Donetick does), add a host to one
 * (Kimai's LAN name) or declare routers of its own, and each of those showed the same bare page
 * while the app started. So this runs on the merged labels, after the app id is interpolated into
 * their keys: run before, a manifest's `{{CI_HUB_APP_ID}}` router would get a chain of its own that
 * then overwrote this builder's, forward auth included.
 *
 * Last in the chain, so it only ever sees the app's own answer. Forward auth runs before it, and its
 * 401s, redirects and 5xx reach the visitor untouched: someone who is not signed in gets the login,
 * never the page. The visitor-set headers the edge middleware strips are also gone by then, and
 * Traefik copies the request's headers into its request for the page.
 */
export function withAppStartingPage(labels: Record<string, string | boolean>): Record<string, string | boolean> {
  const routers = new Set<string>();
  // An existing chain under the spelling it was given, so it is extended rather than doubled.
  const chainKeys = new Map<string, string>();
  for (const key of Object.keys(labels)) {
    const match = HTTP_ROUTER_LABEL.exec(key);
    const [, router, option] = match ?? [];
    if (!router || !option) {
      continue;
    }
    routers.add(router);
    if (option.toLowerCase() === 'middlewares') {
      chainKeys.set(router, key);
    }
  }

  if (routers.size === 0) {
    return labels;
  }

  const result = { ...labels };
  for (const router of routers) {
    const key = chainKeys.get(router) ?? `traefik.http.routers.${router}.middlewares`;
    const current = result[key];
    const chain =
      typeof current === 'string'
        ? current
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        : [];
    if (!chain.includes(APP_STARTING_MIDDLEWARE)) {
      chain.push(APP_STARTING_MIDDLEWARE);
    }
    result[key] = chain.join(',');
  }
  return result;
}

export class TraefikLabelsBuilder {
  private labels: Record<string, string | boolean> = {};
  private effectiveMode: ExposureMode;

  constructor(private params: TraefikLabelsArgs) {
    const mainNetworkName = hubNetworkName();

    this.effectiveMode = params.exposureMode || 'local';

    this.labels = {
      generated: true,
      'traefik.enable': false,
      'traefik.docker.network': mainNetworkName,
      [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.port`]: `${params.internalPort}`,
      ...(params.httpsBackend && {
        [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.scheme`]: 'https',
      }),
    };
  }

  addCloudflareLabels() {
    if (this.effectiveMode !== 'cloudflare' || !this.params.cloudflareOriginHostname) {
      return this;
    }

    const hostRule = `Host(\`${this.params.cloudflareOriginHostname}\`)`;
    const publicHostMiddleware = `${this.params.appId}-${this.params.storeId}-public-host`;
    // First, auth or not: drops the forwarded headers a tunnel visitor can set and no edge hop
    // replaces (X-Real-Ip and the rest), which Traefik keeps because it trusts cloudflared's
    // forwarded headers. See `ci-hub-edge-headers` in assets/traefik/dynamic/dynamic.yml.
    const middlewares: string[] = [EDGE_HEADERS_MIDDLEWARE];

    if (this.params.enableAuth) {
      // BOTH routers, not just the TLS one. The `-insecure` router below serves the same host
      // rule on the `web` entrypoint, and that is precisely the entrypoint the Cloudflare tunnel
      // connects to (see traefik.yml: "Cloudflare Tunnel connects via plain HTTP"). Attaching the
      // forward-auth middleware only to `websecure` left every request that arrived through the
      // tunnel — i.e. all remote traffic to a cloudflare-exposed app — bypassing edge auth
      // entirely, while `curl`-ing the HTTPS entrypoint from the appliance looked correctly
      // gated. An app trusting the edge alone was open to the internet (CI-Engineering#74).
      //
      // Prefer the file provider middleware — `@docker` vanishes when Hub labels flap.
      middlewares.push('ci-hub@file');
    }

    if (this.params.cloudflarePublicHostname) {
      middlewares.push(`${publicHostMiddleware}@docker`);
    }

    Object.assign(this.labels, {
      'traefik.enable': true,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.rule`]: hostRule,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.entrypoints`]: 'web',
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.service`]: `${this.params.appId}-${this.params.storeId}`,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.rule`]: hostRule,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.entrypoints`]: 'websecure',
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.service`]: `${this.params.appId}-${this.params.storeId}`,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.tls.certresolver`]: 'myresolver',
    });

    if (this.params.cloudflarePublicHostname) {
      Object.assign(this.labels, {
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Host`]: this.params.cloudflarePublicHostname,
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Proto`]: 'https',
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Port`]: '443',
      });
    }

    if (middlewares.length > 0) {
      const middlewareChain = middlewares.join(',');
      Object.assign(this.labels, {
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.middlewares`]: middlewareChain,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.middlewares`]: middlewareChain,
      });
    }

    return this;
  }

  addTailscaleLabels() {
    if (this.effectiveMode === 'tailscale') {
      const hostname = this.params.tailscaleHostname || `${this.params.appId}.${this.params.storeId}`;

      Object.assign(this.labels, {
        'traefik.enable': true,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-tailscale.rule`]: `Host(\`${hostname}\`)`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-tailscale.entrypoints`]: 'web',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-tailscale.service`]: `${this.params.appId}-${this.params.storeId}`,
      });
    }
    return this;
  }

  build() {
    return this.labels;
  }
}
