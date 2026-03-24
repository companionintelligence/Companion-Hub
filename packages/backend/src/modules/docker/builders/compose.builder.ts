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
      .setRestartPolicy('unless-stopped')
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

    if (params.isMain) {
      // Only expose port on host if openPort is true (for direct local network access)
      // When exposedLocal=true but openPort=false, Traefik uses Docker internal networking
      // and doesn't need the host port mapping
      if (form.openPort && params.internalPort) {
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
    // It does NOT use host port mappings - only the isMain service gets Traefik labels
    let traefikLabels: Record<string, string | boolean> = {};
    const effectiveExposureMode = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');

    if (effectiveExposureMode !== 'local' && params.isMain && params.internalPort) {
      // Use org info read in getDockerCompose (set by app.helpers.ts in APP_PUBLIC_HOSTNAME)
      // Fallback to using this.domain as public domain if not found
      const publicDomainToUse = this.publicDomain || this.domain;

      // Use full subdomain from APP_PUBLIC_HOSTNAME if available (includes org slug)
      // Otherwise fall back to constructing it from localSubdomain
      const subdomainToUse = this.fullSubdomain || form.localSubdomain || `${appName}-${appStoreId}`;

      const traefikBuilder = new TraefikLabelsBuilder({
        internalPort: params.internalPort,
        appId: appName,
        storeId: appStoreId,
        exposureMode: effectiveExposureMode as 'local' | 'cloudflare' | 'tailscale',
        enableAuth: form.enableAuth,
        localSubdomain: subdomainToUse, // Use full subdomain (with org slug) from APP_PUBLIC_HOSTNAME
        publicDomain: publicDomainToUse,
        localDomain: this.localDomain,
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
    this.localDomain = localDomain || process.env.LOCAL_DOMAIN || 'ci.lan';

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

        // Extract full subdomain and public domain from APP_PUBLIC_HOSTNAME
        // Format: appname-deviceslug-orgslug.publicdomain.com
        for (const line of envLines) {
          if (line.startsWith('APP_PUBLIC_HOSTNAME=')) {
            const exposedDomain = line.split('=')[1]?.trim();
            if (exposedDomain) {
              const parts = exposedDomain.split('.');
              if (parts.length >= 2) {
                this.publicDomain = parts.slice(-2).join('.'); // Get last two parts (e.g., companionintelligence.com)
                // Extract full subdomain (everything before the last two dots, e.g., mattermost-test1-bdc)
                this.fullSubdomain = parts.slice(0, -2).join('.');
              }
            }
            break;
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
