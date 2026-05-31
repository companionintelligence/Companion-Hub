import { DEFAULT_LOCAL_DOMAIN } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { type Service, type ServiceInput, serviceSchema } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import * as yaml from 'yaml';
import { type BuiltService, ServiceBuilder } from './service.builder';
import { TraefikLabelsBuilder } from './traefik-labels.builder';
import { z } from 'zod';

interface Network {
  key: string;
  name: string;
  external: boolean;
  subnet?: string;
  ipam?: {
    config: {
      subnet: string;
    }[];
  };
}

export class DockerComposeBuilder {
  private services: Record<string, BuiltService> = {};
  private networks: Record<string, Omit<Network, 'key'>> = {};
  private domain: string;
  private localDomain: string;

  constructor(domain: string, localDomain: string) {
    this.domain = domain;
    this.localDomain = localDomain;
  }

  addService(service: BuiltService) {
    const { name: _, ...rest } = service;
    this.services[service.name] = rest as BuiltService;
    return this;
  }

  private addServices(services: BuiltService[]) {
    for (const service of services) {
      this.addService(service);
    }
    return this;
  }

  addNetwork(network: Network) {
    const networkConfig: Omit<Network, 'key'> = {
      name: network.name,
      external: network.external,
    };

    if (network.subnet) {
      networkConfig.ipam = {
        config: [{ subnet: network.subnet }],
      };
    }

    this.networks[network.key] = networkConfig;
    return this;
  }

  build() {
    const hasNetworks = Object.keys(this.networks).length > 0;

    return yaml.stringify({
      services: this.services,
      networks: hasNetworks ? this.networks : undefined,
    });
  }

  private fullSubdomain?: string; // Full subdomain including device + org slug (e.g., mattermost-test1-bdc), extracted from APP_PUBLIC_HOSTNAME
  private publicDomain?: string;

  private buildService = (params: Service, form: AppEventFormInput, appUrn: AppUrn, envFile?: string) => {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    // Use domain values set in getDockerCompose (from app env file or defaults)
    const _domain = this.domain;
    const localDomain = this.localDomain;
    const result = serviceSchema.safeParse(params);

    if (!result.success) {
      console.warn(
        `! Service ${params.name} has invalid schema: \n${JSON.stringify(z.treeifyError(result.error), null, 2)}\nNotify the app maintainer`,
      );
    }

    const service = new ServiceBuilder();
    service
      .setImage(params.image)
      .setName(params.name)
      .setEnvironment(params.environment)
      .setCommand(params.command)
      .setHealthCheck(params.healthCheck)
      .setDependsOn(params.dependsOn)
      .setVolumes(params.volumes)
      .setRestartPolicy(params.restart ?? 'unless-stopped')
      .setExtraHosts(params.extraHosts)
      .setUlimits(params.ulimits)
      .setPorts(params.addPorts)
      .setNetworkMode(params.networkMode)
      .setCapAdd(params.capAdd)
      .setDeploy(params.deploy)
      .setHostname(params.hostname)
      .setDevices(params.devices)
      .setEntrypoint(params.entrypoint)
      .setPid(params.pid)
      .setPrivileged(params.privileged)
      .setTty(params.tty)
      .setUser(params.user)
      .setWorkingDir(params.workingDir)
      .setShmSize(params.shmSize)
      .setCapDrop(params.capDrop)
      .setLogging(params.logging)
      .setReadOnly(params.readOnly)
      .setSecurityOpt(params.securityOpt)
      .setStopSignal(params.stopSignal)
      .setStopGracePeriod(params.stopGracePeriod)
      .setStdinOpen(params.stdinOpen)
      .setSysctls(params.sysctls)
      .setDNS(params.dns)
      .setNetwork(`${appName}_${appStoreId}_network`);

    if (envFile) {
      service.setEnvFile([envFile]);
    }

    // Add main service to ci_os_hub_network for inter-app communication
    // This allows apps to communicate with each other when needed
    const mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;
    if (params.isMain || params.addToMainNetwork) {
      service.setNetwork(mainNetworkName, 1);
    }

    const effectiveExposureMode = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');

    if (params.isMain) {
      // Publish host port for local-mode apps, explicit openPort, or Cloudflare/Tailscale
      // exposed apps so the UI remains reachable on the LAN during DNS propagation.
      if ((form.openPort || effectiveExposureMode === 'local' || form.exposedLocal) && params.internalPort) {
        service.setPort({
          containerPort: params.internalPort,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intended
          hostPort: '${APP_PORT}',
        });
      }
    }

    // Set default labels
    const defaultLabels: Record<string, string | boolean> = {
      'ci-os-hub.managed': true,
      'ci-os-hub.appurn': appUrn,
    };

    // Generate Traefik labels based on exposure mode
    // Traefik routes using Docker internal networking (container IP + internalPort)
    // It does NOT use host port mappings — only the isMain service gets Traefik labels
    let traefikLabels: Record<string, string | boolean> = {};

    if (effectiveExposureMode !== 'local' && params.isMain && params.internalPort) {
      const subdomainToUse = this.fullSubdomain || form.localSubdomain || `${appName}-${appStoreId}`;

      const traefikBuilder = new TraefikLabelsBuilder({
        internalPort: params.internalPort,
        appId: appName,
        storeId: appStoreId,
        exposureMode: effectiveExposureMode as 'local' | 'cloudflare' | 'tailscale',
        enableAuth: form.enableAuth,
        localSubdomain: subdomainToUse,
        publicDomain: this.publicDomain || this.domain,
        localDomain: this.localDomain,
        httpsBackend: params.httpsBackend,
      });

      traefikBuilder.addExposedLocalLabels();
      traefikBuilder.addTailscaleLabels();
      traefikLabels = traefikBuilder.build();
    }

    // Merge default labels, Traefik labels, and extra labels from app config
    // Pass localDomain to interpolateVariables to replace ${LOCAL_DOMAIN} with actual value
    service.setLabels({ ...defaultLabels, ...traefikLabels, ...params.extraLabels }).interpolateVariables(`${appName}-${appStoreId}`, localDomain);

    return service.build();
  };

  public async getDockerCompose(
    services: ServiceInput[],
    form: AppEventFormInput,
    appUrn: AppUrn,
    subnet: string,
    domain?: string,
    localDomain?: string,
    envFile?: string,
  ) {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    // Store domain values for use in buildService
    this.domain = domain || process.env.DOMAIN || 'example.com';
    this.localDomain = localDomain || process.env.LOCAL_DOMAIN || DEFAULT_LOCAL_DOMAIN;

    // Read full subdomain (with org slug) and public domain from env file if available (set by app.helpers.ts)
    // APP_PUBLIC_HOSTNAME format: appname-deviceslug-orgslug.publicdomain.com
    // We extract the full subdomain (appname-deviceslug-orgslug) directly instead of reconstructing it
    this.fullSubdomain = undefined; // Full subdomain including device + org slug (e.g., mattermost-test1-bdc)
    this.publicDomain = undefined;

    if (envFile) {
      try {
        const fs = await import('node:fs/promises');
        const envContent = await fs.readFile(envFile, 'utf-8');
        const envLines = envContent.split('\n');

        // Parse all relevant env vars in a single pass.
        // Prefer APP_PUBLIC_DOMAIN (set since it was added to avoid fragile hostname parsing)
        // and fall back to splitting APP_PUBLIC_HOSTNAME for backward-compatibility with
        // older app installations that pre-date APP_PUBLIC_DOMAIN.
        let appPublicHostname: string | undefined;
        let appPublicDomain: string | undefined;

        for (const line of envLines) {
          if (line.startsWith('APP_PUBLIC_DOMAIN=')) {
            appPublicDomain = line.split('=')[1]?.trim();
          } else if (line.startsWith('APP_PUBLIC_HOSTNAME=')) {
            appPublicHostname = line.split('=')[1]?.trim();
          }
        }

        if (appPublicHostname) {
          // Derive fullSubdomain from APP_PUBLIC_HOSTNAME.
          // Priority order for the domain portion:
          //   1. APP_PUBLIC_DOMAIN (written alongside APP_PUBLIC_HOSTNAME for new installs)
          //   2. form.publicDomain (DB-stored value; covers apps whose env predates APP_PUBLIC_DOMAIN,
          //      including multi-label domains like my.lifescope.io that the slice(-2) heuristic
          //      would truncate incorrectly)
          //   3. Slice-last-2 heuristic (backward-compat for simple 2-part TLDs only)
          const formPublicDomain = typeof form.publicDomain === 'string' ? form.publicDomain.trim() || undefined : undefined;
          const resolvedDomain =
            appPublicDomain ||
            formPublicDomain ||
            (() => {
              const parts = appPublicHostname?.split('.');
              return parts && parts.length >= 2 ? parts.slice(-2).join('.') : undefined;
            })();

          if (resolvedDomain) {
            this.publicDomain = resolvedDomain;
            // Full subdomain is everything before the first occurrence of the domain suffix.
            const domainSuffix = `.${resolvedDomain}`;
            if (appPublicHostname.endsWith(domainSuffix)) {
              this.fullSubdomain = appPublicHostname.slice(0, -domainSuffix.length);
            } else {
              // Fallback: strip as many trailing segments as the domain has parts.
              const parts = appPublicHostname.split('.');
              const domainParts = resolvedDomain.split('.').length;
              this.fullSubdomain = parts.slice(0, -domainParts).join('.');
            }
          }
        }
      } catch (_error) {
        // If we can't read the env file, continue without org info
        // Traefik will still work with just the local domain
      }
    }

    // Build a map of service names to their healthcheck status for validation
    const serviceHealthcheckMap = new Map<string, boolean>();
    for (const service of services) {
      serviceHealthcheckMap.set(service.name, !!service.healthCheck);
    }

    // Validate and fix depends_on conditions: if a service depends on another with
    // condition: service_healthy but the target has no healthcheck, change to service_started
    const fixedServices = services.map((service) => {
      if (service.dependsOn && typeof service.dependsOn === 'object' && !Array.isArray(service.dependsOn)) {
        const fixedDependsOn: Record<string, { condition: 'service_healthy' | 'service_started' | 'service_completed_successfully' }> = {};
        for (const [depName, depConfig] of Object.entries(service.dependsOn)) {
          if (depConfig.condition === 'service_healthy') {
            const targetHasHealthcheck = serviceHealthcheckMap.get(depName);
            if (targetHasHealthcheck) {
              fixedDependsOn[depName] = depConfig;
            } else {
              // Target service has no healthcheck, downgrade to service_started
              fixedDependsOn[depName] = { condition: 'service_started' as const };
            }
          } else {
            fixedDependsOn[depName] = depConfig;
          }
        }
        return { ...service, dependsOn: fixedDependsOn };
      }
      return service;
    });

    const myServices = fixedServices.map((service) => this.buildService(service, form, appUrn, envFile));

    const mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;

    const dockerCompose = this.addServices(myServices)
      .addNetwork({
        key: mainNetworkName,
        name: mainNetworkName,
        external: true,
      })
      .addNetwork({
        key: `${appName}_${appStoreId}_network`,
        name: `${appName}_${appStoreId}_network`,
        external: false,
        subnet,
      });

    return dockerCompose.build();
  }
}
