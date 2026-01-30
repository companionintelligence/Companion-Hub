interface TraefikLabelsArgs {
  internalPort: number | string;
  appId: string;
  exposedLocal?: boolean;
  exposed?: boolean;
  storeId: string;
  enableAuth?: boolean;
  localSubdomain?: string; // Full subdomain including org slug (e.g., mattermost-bdc), extracted from APP_PUBLIC_HOSTNAME
  publicDomain?: string; // Public domain (e.g., companionintelligence.com)
  localDomain?: string; // Local domain (e.g., tipi.lan)
}

export class TraefikLabelsBuilder {
  private labels: Record<string, string | boolean> = {};

  constructor(private params: TraefikLabelsArgs) {
    const mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;
    this.labels = {
      generated: true,
      'traefik.enable': false,
      'traefik.docker.network': mainNetworkName,
      // REMOVED: HTTPS redirect middleware - Cloudflare Tunnel needs plain HTTP
      // [`traefik.http.middlewares.${params.appId}-${params.storeId}-web-redirect.redirectscheme.scheme`]: 'https',
      [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.port`]: `${params.internalPort}`,
    };
  }

  addExposedLabels() {
    if (this.params.exposed) {
      Object.assign(this.labels, {
        'traefik.enable': true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Traefik label requires literal ${APP_PUBLIC_HOSTNAME}
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.rule`]: 'Host(`${APP_PUBLIC_HOSTNAME}`)',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.entrypoints`]: 'web',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.service`]: `${this.params.appId}-${this.params.storeId}`,
        // REMOVED: No HTTPS redirect middleware - Cloudflare Tunnel handles SSL
        // [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.middlewares`]: `${this.params.appId}-${this.params.storeId}-web-redirect`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Traefik label requires literal ${APP_PUBLIC_HOSTNAME}
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.rule`]: 'Host(`${APP_PUBLIC_HOSTNAME}`)',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.tls.certresolver`]: 'myresolver',
      });

      if (this.params.enableAuth) {
        Object.assign(this.labels, {
          // Reference middleware from Docker provider (defined on ci-os-hub container)
          [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.middlewares`]: 'runtipi@docker',
        });
      }
    }
    return this;
  }

  addExposedLocalLabels() {
    if (this.params.exposedLocal) {
      // localSubdomain is already the full subdomain (appname-orgslug) from APP_PUBLIC_HOSTNAME
      // No need to add org slug again - it's already included
      const subdomain = this.params.localSubdomain || `${this.params.appId}-${this.params.storeId}`;

      // When exposedLocal is true, we're using Cloudflare Tunnel to expose apps to the internet
      // Cloudflare Tunnel sends requests with the public domain Host header (e.g., mattermost-bdc.companionintelligence.com)
      // We only need to configure Traefik to accept the public domain, not the local domain
      // Use publicDomain if provided, otherwise fall back to domain (should always be set via compose.builder.ts)
      const domainToUse = this.params.publicDomain || 'example.com'; // Fallback should never be used in practice
      const publicHost = `${subdomain}.${domainToUse}`;
      const hostRule = `Host(\`${publicHost}\`)`;

      Object.assign(this.labels, {
        'traefik.enable': true,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.rule`]: hostRule,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.entrypoints`]: 'web',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.service`]: `${this.params.appId}-${this.params.storeId}`,
        // REMOVED: No HTTPS redirect middleware - Cloudflare Tunnel handles SSL
        // [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.middlewares`]: `${this.params.appId}-${this.params.storeId}-web-redirect`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.rule`]: hostRule,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.entrypoints`]: 'websecure',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.tls`]: true,
      });

      if (this.params.enableAuth) {
        Object.assign(this.labels, {
          // Reference middleware from Docker provider (defined on ci-os-hub container)
          [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.middlewares`]: 'runtipi@docker',
        });
      }
    }
    return this;
  }

  build() {
    return this.labels;
  }
}
