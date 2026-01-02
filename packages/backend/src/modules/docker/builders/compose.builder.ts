import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { type Service, type ServiceInput, serviceSchema } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import * as yaml from 'yaml';
import { type BuiltService, ServiceBuilder } from './service.builder';
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

  private buildService = (params: Service, form: AppEventFormInput, appUrn: AppUrn) => {
    const { appName, appStoreId } = extractAppUrn(appUrn);
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

    // Add main service to ci_os_hub_network for inter-app communication
    // This allows apps to communicate with each other when needed
    if (params.isMain || params.addToMainNetwork) {
      service.setNetwork('ci_os_hub_network', 1);
    }

    if (params.isMain) {
      // When exposedLocal is true, apps go through Traefik - no port mapping needed
      // Only open ports for legacy openPort mode (local network access only)
      if (form.openPort && !form.exposedLocal && params.internalPort) {
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

    // Add Traefik labels when exposedLocal is enabled (app published to internet via Traefik)
    if (params.isMain && form.exposedLocal && params.internalPort) {
      const serviceId = `${appName}-${appStoreId}`;
      const subdomain = form.localSubdomain || serviceId;
      
      // Traefik configuration for the app
      defaultLabels['traefik.enable'] = true;
      defaultLabels['traefik.docker.network'] = 'ci_os_hub_network';
      
      // Service configuration
      defaultLabels[`traefik.http.services.${serviceId}.loadbalancer.server.port`] = String(params.internalPort);
      
      // HTTPS redirect middleware
      defaultLabels[`traefik.http.middlewares.${serviceId}-web-redirect.redirectscheme.scheme`] = 'https';
      
      // Router for public domain (insecure - redirects to HTTPS)
      // This is used by Cloudflare Tunnel for internet access
      defaultLabels[`traefik.http.routers.${serviceId}-insecure.rule`] = `Host(\`${subdomain}.\${DOMAIN}\`)`;
      defaultLabels[`traefik.http.routers.${serviceId}-insecure.entrypoints`] = 'web';
      defaultLabels[`traefik.http.routers.${serviceId}-insecure.service`] = serviceId;
      defaultLabels[`traefik.http.routers.${serviceId}-insecure.middlewares`] = `${serviceId}-web-redirect`;
      
      // Router for public domain (secure)
      // This is used by Cloudflare Tunnel for internet access (HTTPS)
      defaultLabels[`traefik.http.routers.${serviceId}.rule`] = `Host(\`${subdomain}.\${DOMAIN}\`)`;
      defaultLabels[`traefik.http.routers.${serviceId}.entrypoints`] = 'websecure';
      defaultLabels[`traefik.http.routers.${serviceId}.service`] = serviceId;
      defaultLabels[`traefik.http.routers.${serviceId}.tls.certresolver`] = 'myresolver';
      
      // Router for local domain (insecure - redirects to HTTPS)
      // This is for local network access
      defaultLabels[`traefik.http.routers.${serviceId}-local-insecure.rule`] = `Host(\`${subdomain}.\${LOCAL_DOMAIN}\`)`;
      defaultLabels[`traefik.http.routers.${serviceId}-local-insecure.entrypoints`] = 'web';
      defaultLabels[`traefik.http.routers.${serviceId}-local-insecure.service`] = serviceId;
      defaultLabels[`traefik.http.routers.${serviceId}-local-insecure.middlewares`] = `${serviceId}-web-redirect`;
      
      // Router for local domain (secure)
      // This is for local network access (HTTPS)
      defaultLabels[`traefik.http.routers.${serviceId}-local.rule`] = `Host(\`${subdomain}.\${LOCAL_DOMAIN}\`)`;
      defaultLabels[`traefik.http.routers.${serviceId}-local.entrypoints`] = 'websecure';
      defaultLabels[`traefik.http.routers.${serviceId}-local.service`] = serviceId;
      defaultLabels[`traefik.http.routers.${serviceId}-local.tls`] = true;
      
      // Optional: Add auth middleware if enableAuth is true
      // Apply to both public and local routes
      if (form.enableAuth) {
        const authMiddleware = 'ci-hub';
        defaultLabels[`traefik.http.routers.${serviceId}.middlewares`] = authMiddleware;
        defaultLabels[`traefik.http.routers.${serviceId}-local.middlewares`] = authMiddleware;
      }
    }

    // Merge default labels with extra labels from app config
    service.setLabels({ ...defaultLabels, ...params.extraLabels }).interpolateVariables(`${appName}-${appStoreId}`);

    return service.build();
  };

  public getDockerCompose(services: ServiceInput[], form: AppEventFormInput, appUrn: AppUrn, subnet: string) {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    const myServices = services.map((service) => this.buildService(service, form, appUrn));

    const dockerCompose = this.addServices(myServices)
      .addNetwork({
        key: 'ci_os_hub_network',
        name: 'ci_os_hub_network',
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
