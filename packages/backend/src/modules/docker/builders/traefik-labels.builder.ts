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
    const middlewares: string[] = [];

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
