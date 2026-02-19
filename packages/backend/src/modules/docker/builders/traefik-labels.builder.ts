export type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

interface TraefikLabelsArgs {
  internalPort: number | string;
  appId: string;
  exposureMode: ExposureMode;
  /** @deprecated Use exposureMode instead */
  exposedLocal?: boolean;
  /** @deprecated Use exposureMode instead */
  exposed?: boolean;
  storeId: string;
  enableAuth?: boolean;
  localSubdomain?: string;
  publicDomain?: string;
  localDomain?: string;
  tailscaleHostname?: string;
}

export class TraefikLabelsBuilder {
  private labels: Record<string, string | boolean> = {};
  private effectiveMode: ExposureMode;

  constructor(private params: TraefikLabelsArgs) {
    const mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;

    // Resolve effective mode — prefer explicit exposureMode, fall back to legacy booleans
    if (params.exposureMode && params.exposureMode !== 'local') {
      this.effectiveMode = params.exposureMode;
    } else if (params.exposedLocal) {
      this.effectiveMode = 'cloudflare';
    } else if (params.exposed) {
      this.effectiveMode = 'cloudflare';
    } else {
      this.effectiveMode = params.exposureMode || 'local';
    }

    this.labels = {
      generated: true,
      'traefik.enable': false,
      'traefik.docker.network': mainNetworkName,
      [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.port`]: `${params.internalPort}`,
    };
  }

  addExposedLabels() {
    if (this.effectiveMode === 'cloudflare' || this.params.exposed) {
      Object.assign(this.labels, {
        'traefik.enable': true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Traefik label requires literal ${APP_PUBLIC_HOSTNAME}
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.rule`]: 'Host(`${APP_PUBLIC_HOSTNAME}`)',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.entrypoints`]: 'web',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-insecure.service`]: `${this.params.appId}-${this.params.storeId}`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Traefik label requires literal ${APP_PUBLIC_HOSTNAME}
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.rule`]: 'Host(`${APP_PUBLIC_HOSTNAME}`)',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.tls.certresolver`]: 'myresolver',
      });

      if (this.params.enableAuth) {
        Object.assign(this.labels, {
          [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.middlewares`]: 'runtipi@docker',
        });
      }
    }
    return this;
  }

  addExposedLocalLabels() {
    if (this.effectiveMode === 'cloudflare' || this.params.exposedLocal) {
      const subdomain = this.params.localSubdomain || `${this.params.appId}-${this.params.storeId}`;
      const domainToUse = this.params.publicDomain || 'example.com';
      const publicHost = `${subdomain}.${domainToUse}`;
      const hostRule = `Host(\`${publicHost}\`)`;

      Object.assign(this.labels, {
        'traefik.enable': true,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.rule`]: hostRule,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.entrypoints`]: 'web',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local-insecure.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.rule`]: hostRule,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.entrypoints`]: 'websecure',
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.tls`]: true,
      });

      if (this.params.enableAuth) {
        Object.assign(this.labels, {
          [`traefik.http.routers.${this.params.appId}-${this.params.storeId}-local.middlewares`]: 'runtipi@docker',
        });
      }
    }
    return this;
  }

  addTailscaleLabels() {
    if (this.effectiveMode === 'tailscale') {
      // Tailscale Serve routes traffic via the host's Tailscale daemon
      // Traefik just needs to accept traffic on the local port — Tailscale handles routing
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
