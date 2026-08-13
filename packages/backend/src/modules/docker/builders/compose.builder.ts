import { DEFAULT_LOCAL_DOMAIN } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import {
  type Service,
  type ServiceInput,
  serviceSchema,
  collectServiceSecurityViolations,
  TRUSTED_APP_SECURITY_ALLOWLIST,
} from '@ci-hub/common/schemas';
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

type ServiceVolume = NonNullable<Service['volumes']>[number];

/**
 * Turns a bind mount's host path into a stable docker volume name (`${APP_DATA_DIR}/data/db` →
 * `data-db`). Derived from the host path rather than the mount point or the service: sidecars that
 * share a data directory declare the same host path and so land on the same volume, while two
 * databases in one app land on different ones. Keying on the mount point instead would merge them —
 * `fastgpt`'s two postgres services and `postiz`' two postgres services each declare distinct host
 * directories under the same `/var/lib/postgresql/data`, and sharing one volume would put two
 * servers (postiz': two different major versions) on a single data directory. The host path is also
 * stable across app updates; a name that drifted between builds would orphan the app's data.
 *
 * Characters that stand in for a separator are escaped rather than simply replaced, to keep
 * distinct paths apart: `-` doubles before `/` becomes `-`, and `_` doubles before invalid runs
 * become `_`. This is injective across `[a-z0-9/]` — every database directory in this catalog —
 * which read exactly as the path does. It is NOT injective across every possible host path: a `-`
 * adjacent to a `/` (`/a-/b` vs `/a/-b`), distinct invalid characters collapsing to one `_`
 * (`/a b` vs `/a:b`), or the leading-`v` prefix meeting a real `v` all converge. The caller
 * (`registerVolume`) rejects any such collision at build time rather than merge two directories, so
 * this function does not need to guarantee injectivity for inputs the catalog never produces.
 *
 * A leading non-alphanumeric is prefixed rather than trimmed: trimming is what would undo the
 * escaping above and re-merge the paths it exists to keep apart.
 */
function deriveVolumeName(hostPath: string): string {
  const slug = hostPath
    // The app-data root is the same for every volume, so it carries no identity.
    .replace(/\$\{APP_DATA_DIR\}/g, '')
    // Leading and trailing separators are not part of the path's identity: `/data/db/` and
    // `/data/db` are the same directory and must resolve to the same volume.
    .replace(/^\/+|\/+$/g, '')
    .replace(/-/g, '--')
    .replace(/_/g, '__')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_');

  if (!slug) {
    return 'data';
  }

  // Docker requires a volume name to start with an alphanumeric.
  return /^[a-zA-Z0-9]/.test(slug) ? slug : `v${slug}`;
}

export class DockerComposeBuilder {
  private services: Record<string, BuiltService> = {};
  private networks: Record<string, Omit<Network, 'key'>> = {};
  private volumes: Record<string, Record<string, never>> = {};
  /**
   * Which source claimed each top-level volume name, so a collision can be caught. A declared
   * `volumeName` is keyed by its own name; a redirected bind by its host path. `deriveVolumeName`
   * aims to be injective but is not provably so for every possible host path, and a derived name
   * can also land on an explicitly declared one — either way, two different sources mapping to one
   * volume would silently merge two data directories. This turns that into a build-time error.
   */
  private volumeSources: Record<string, string> = {};
  private localDomain: string;
  private cloudflareOriginHostname?: string;
  private cloudflarePublicHostname?: string;
  private defaultCpuLimit?: string;
  private defaultMemoryLimit?: string;
  private readonly posixPermissionsSupported: boolean;

  /**
   * @param posixPermissionsSupported Whether the app-data filesystem can carry POSIX
   * ownership/permissions. False on Windows-backed host paths, where volumes marked
   * `requiresPosixPermissions` are mounted as named volumes instead. Defaults to true so callers
   * that cannot probe keep bind mounts.
   */
  constructor(_domain: string, localDomain: string, posixPermissionsSupported = true) {
    this.localDomain = localDomain;
    this.posixPermissionsSupported = posixPermissionsSupported;
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
    const hasVolumes = Object.keys(this.volumes).length > 0;

    return yaml.stringify({
      services: this.services,
      networks: hasNetworks ? this.networks : undefined,
      // Declared at the top level so compose scopes them to this app's project and
      // `down --volumes` (uninstall with data, reset) still reclaims them.
      volumes: hasVolumes ? this.volumes : undefined,
    });
  }

  /**
   * Picks the mount source for a volume. A manifest that names a volume outright gets it declared
   * at the top level; a bind mount that needs real ownership is redirected onto a named volume when
   * the host filesystem cannot carry permissions. Everything else stays a plain bind mount, so
   * platforms where binds already work keep their existing data in place.
   */
  /**
   * Registers a top-level named volume, rejecting a name already claimed by a different source.
   * The same source registering twice is fine — sidecars sharing one data directory declare the
   * same host path on purpose and must land on the same volume.
   */
  private registerVolume(name: string, source: string) {
    const existing = this.volumeSources[name];
    if (existing !== undefined && existing !== source) {
      throw new Error(
        `Volume name "${name}" is claimed by two different sources (${existing} and ${source}). ` +
          'Refusing to merge two distinct data directories into one volume.',
      );
    }
    this.volumeSources[name] = source;
    this.volumes[name] = {};
  }

  private resolveVolume = (volume: ServiceVolume) => {
    if (volume.volumeName) {
      this.registerVolume(volume.volumeName, `volumeName:${volume.volumeName}`);
      return volume;
    }

    // `=== true`, not truthiness: `requiresPosixPermissions` is only warn-validated at the build
    // sink, so a malformed non-boolean (e.g. the string "false") would otherwise read as truthy and
    // redirect a bind the author never marked.
    if (volume.requiresPosixPermissions !== true || this.posixPermissionsSupported || volume.hostPath === undefined) {
      return volume;
    }

    // Key the collision check on the directory identity, not the raw string, so `/data/db` and
    // `/data/db/` — the same directory — share a volume, while genuinely different directories that
    // happen to derive the same name are rejected.
    const identity = volume.hostPath
      .replace(/\$\{APP_DATA_DIR\}/g, '')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const volumeName = deriveVolumeName(volume.hostPath);
    this.registerVolume(volumeName, `hostPath:${identity}`);

    return { ...volume, hostPath: undefined, volumeName };
  };

  private buildService = (params: Service, form: AppEventFormInput, appUrn: AppUrn, envFile?: string) => {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    const localDomain = this.localDomain;
    const result = serviceSchema.safeParse(params);

    if (!result.success) {
      console.warn(
        `! Service ${params.name} has invalid schema: \n${JSON.stringify(z.treeifyError(result.error), null, 2)}\nNotify the app maintainer`,
      );
    }

    // Enforce the app sandbox at the install sink: reject host-privileged features
    // (privileged, host network/PID namespaces, denied host-path binds like /var/run/docker.sock)
    // unless the app is explicitly granted them in TRUSTED_APP_SECURITY_ALLOWLIST. A warn-only
    // schema check is not enough here — a malicious or compromised manifest would otherwise be
    // rendered into a root-equivalent container. This throw aborts the install (the caller in
    // command.ts surfaces it as an app error).
    const securityViolations = collectServiceSecurityViolations(params, TRUSTED_APP_SECURITY_ALLOWLIST[appName]);
    if (securityViolations.length > 0) {
      const details = securityViolations.map((v) => `${v.path.join('.')}${v.hostPath ? ` (${v.hostPath})` : ''} [${v.message}]`).join(', ');
      // An unusable volume name is rejected on its shape, before any grant is consulted, so
      // pointing the operator at the allowlist would send them after a fix that cannot work.
      const grantable = securityViolations.some((v) => v.message !== 'CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
      throw new Error(
        grantable
          ? `App "${appName}" service "${params.name}" requests host-privileged access that is not permitted by the app sandbox: ${details}. ` +
              'If this app legitimately requires it, add an audited entry to TRUSTED_APP_SECURITY_ALLOWLIST in @ci-hub/common/schemas.'
          : `App "${appName}" service "${params.name}" declares an unusable volume name: ${details}. ` +
              'A volume name must start with a letter or number; a path belongs in hostPath, which is checked against the app sandbox.',
      );
    }

    const effectiveCpuLimit = form.cpuLimit?.trim() || this.defaultCpuLimit;
    const effectiveMemoryLimit = (typeof form.memoryLimit === 'string' ? form.memoryLimit.trim() : undefined) || this.defaultMemoryLimit;
    // App-provided limits always win; defaults only fill the gaps
    const applyCpuLimit = Boolean(effectiveCpuLimit && !params.deploy?.resources?.limits?.cpus);
    const applyMemoryLimit = Boolean(effectiveMemoryLimit && !params.deploy?.resources?.limits?.memory);
    const deployConfig =
      applyCpuLimit || applyMemoryLimit
        ? {
            ...(params.deploy ?? {}),
            resources: {
              ...(params.deploy?.resources ?? {}),
              limits: {
                ...(params.deploy?.resources?.limits ?? {}),
                ...(applyCpuLimit ? { cpus: effectiveCpuLimit } : {}),
                ...(applyMemoryLimit ? { memory: effectiveMemoryLimit } : {}),
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
      .setVolumes(params.volumes?.map(this.resolveVolume))
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
      .setPlatform(params.platform)
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
        cloudflareOriginHostname: this.cloudflareOriginHostname,
        cloudflarePublicHostname: this.cloudflarePublicHostname,
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
    cloudflareOriginHostname?: string,
    cloudflarePublicHostname?: string,
    defaultCpuLimit?: string,
    defaultMemoryLimit?: string,
  ) {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    this.localDomain = localDomain || process.env.LOCAL_DOMAIN || DEFAULT_LOCAL_DOMAIN;
    this.cloudflareOriginHostname = cloudflareOriginHostname;
    this.cloudflarePublicHostname = cloudflarePublicHostname;
    this.defaultCpuLimit = defaultCpuLimit?.trim() || undefined;
    this.defaultMemoryLimit = defaultMemoryLimit?.trim() || undefined;

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
