import { DEFAULT_LOCAL_DOMAIN } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { type Service, type ServiceInput, serviceSchema } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import * as yaml from 'yaml';
import { type BuiltService, ServiceBuilder } from './service.builder';
import { TraefikLabelsBuilder } from './traefik-labels.builder';
import { publishesHostPort } from '@/modules/apps/app-exposure.helpers';
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
  private localDomain: string;
  private publicWebHostname?: string;
  private defaultCpuLimit?: string;

  constructor(_domain: string, localDomain: string) {
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

  private buildService = (params: Service, form: AppEventFormInput, appUrn: AppUrn, envFile?: string) => {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    const localDomain = this.localDomain;
    const result = serviceSchema.safeParse(params);

    if (!result.success) {
      console.warn(
        `! Service ${params.name} has invalid schema: \n${JSON.stringify(z.treeifyError(result.error), null, 2)}\nNotify the app maintainer`,
      );
    }

    const effectiveCpuLimit = form.cpuLimit?.trim() || this.defaultCpuLimit;
    const deployConfig =
      effectiveCpuLimit && !params.deploy?.resources?.limits?.cpus
        ? {
            ...(params.deploy ?? {}),
            resources: {
              ...(params.deploy?.resources ?? {}),
              limits: {
                ...(params.deploy?.resources?.limits ?? {}),
                cpus: effectiveCpuLimit,
              },
            },
          }
        : params.deploy;

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
      .setDeploy(deployConfig)
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

    const mainNetworkName = `${process.env.HUB_CONTAINER_NAME || 'ci-os-hub'}_network`;
    if (params.isMain || params.addToMainNetwork) {
      service.setNetwork(mainNetworkName, 1);
    }

    const effectiveExposureMode = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');

    if (params.isMain) {
      if (publishesHostPort(form) && params.internalPort) {
        service.setPort({
          containerPort: params.internalPort,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intended
          hostPort: '${APP_PORT}',
        });
      }
    }

    const defaultLabels: Record<string, string | boolean> = {
      'ci-os-hub.managed': true,
      'ci-os-hub.appurn': appUrn,
    };

    let traefikLabels: Record<string, string | boolean> = {};

    if (effectiveExposureMode !== 'local' && params.isMain && params.internalPort) {
      const traefikBuilder = new TraefikLabelsBuilder({
        internalPort: params.internalPort,
        appId: appName,
        storeId: appStoreId,
        exposureMode: effectiveExposureMode as 'local' | 'cloudflare' | 'tailscale',
        enableAuth: form.enableAuth,
        publicWebHostname: this.publicWebHostname,
        localDomain: this.localDomain,
        httpsBackend: params.httpsBackend,
      });

      traefikBuilder.addCloudflareLabels();
      traefikBuilder.addTailscaleLabels();
      traefikLabels = traefikBuilder.build();
    }

    service.setLabels({ ...defaultLabels, ...traefikLabels, ...params.extraLabels }).interpolateVariables(`${appName}-${appStoreId}`, localDomain);

    return service.build();
  };

  public async getDockerCompose(
    services: ServiceInput[],
    form: AppEventFormInput,
    appUrn: AppUrn,
    subnet: string,
    _domain?: string,
    localDomain?: string,
    envFile?: string,
    publicWebHostname?: string,
    defaultCpuLimit?: string,
  ) {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    this.localDomain = localDomain || process.env.LOCAL_DOMAIN || DEFAULT_LOCAL_DOMAIN;
    this.publicWebHostname = publicWebHostname;
    this.defaultCpuLimit = defaultCpuLimit?.trim() || undefined;

    const serviceHealthcheckMap = new Map<string, boolean>();
    for (const service of services) {
      serviceHealthcheckMap.set(service.name, !!service.healthCheck);
    }

    const fixedServices = services.map((service) => {
      if (service.dependsOn && typeof service.dependsOn === 'object' && !Array.isArray(service.dependsOn)) {
        const fixedDependsOn: Record<string, { condition: 'service_healthy' | 'service_started' | 'service_completed_successfully' }> = {};
        for (const [depName, depConfig] of Object.entries(service.dependsOn)) {
          if (depConfig.condition === 'service_healthy') {
            const targetHasHealthcheck = serviceHealthcheckMap.get(depName);
            if (targetHasHealthcheck) {
              fixedDependsOn[depName] = depConfig;
            } else {
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
