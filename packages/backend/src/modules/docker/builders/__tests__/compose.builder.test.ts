/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: intended */
import { createAppUrn } from '@/common/helpers/app-helpers';
import { CI_MARKETPLACE_STORE_SLUG } from '@/core/portal/portal.constants';
import type { ServiceInput } from '@ci-hub/common/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import yaml from 'yaml';
import { DockerComposeBuilder } from '../compose.builder';
import { ServiceBuilder } from '../service.builder';

const urn = createAppUrn('nginx', 'store-id');
const subnet = '10.128.1.0/24';

describe('DockerComposeBuilder', () => {
  let composeBuilder: DockerComposeBuilder;
  let serviceBuilder: ServiceBuilder;

  beforeEach(() => {
    composeBuilder = new DockerComposeBuilder('ci.computer', 'ci.lan');
    serviceBuilder = new ServiceBuilder();
  });

  it('should build a docker-compose file', async () => {
    const serviceName = 'service';
    const service: ServiceInput = {
      name: serviceName,
      image: 'image',
      internalPort: 80,
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);
    expect(compose).toMatchSnapshot();
  });

  it('labels the app network as Hub-managed and leaves the shared Hub networks unlabelled', async () => {
    // The Hub's boot-time `docker network prune` is filtered on this label. Without it the
    // prune reclaims every idle network on the host, including other compose stacks'.
    const compose = await composeBuilder.getDockerCompose([{ name: 'service', image: 'image' }], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    expect(parsed.networks['nginx_store-id_network'].labels).toMatchObject({
      'ci-hub.managed': true,
      'ci-hub.appurn': urn,
    });
    for (const [name, network] of Object.entries<{ external?: boolean; labels?: unknown }>(parsed.networks)) {
      if (name === 'nginx_store-id_network') continue;
      expect(network.external).toBe(true);
      expect(network.labels).toBeUndefined();
    }
  });

  it('attaches main services to both Hub networks during canonical migration', async () => {
    const previousHubContainerName = process.env.HUB_CONTAINER_NAME;
    process.env.HUB_CONTAINER_NAME = 'ci-hub';
    try {
      const compose = await composeBuilder.getDockerCompose([{ name: 'service', image: 'image', isMain: true }], {}, urn, subnet);
      const parsed = yaml.parse(compose);

      expect(parsed.services.service.networks).toMatchObject({
        'ci-hub_network': { gw_priority: 1 },
        'ci-os-hub_network': { gw_priority: 0 },
      });
      expect(parsed.networks['ci-hub_network']).toEqual({ name: 'ci-hub_network', external: true });
      expect(parsed.networks['ci-os-hub_network']).toEqual({ name: 'ci-os-hub_network', external: true });
    } finally {
      if (previousHubContainerName === undefined) delete process.env.HUB_CONTAINER_NAME;
      else process.env.HUB_CONTAINER_NAME = previousHubContainerName;
    }
  });

  it('writes only the existing legacy Hub network during an image-only update', async () => {
    const previousHubContainerName = process.env.HUB_CONTAINER_NAME;
    const previousRabbitmqHost = process.env.RABBITMQ_HOST;
    delete process.env.HUB_CONTAINER_NAME;
    process.env.RABBITMQ_HOST = 'ci-os-hub-queue';
    try {
      const compose = await composeBuilder.getDockerCompose([{ name: 'service', image: 'image', isMain: true }], {}, urn, subnet);
      const parsed = yaml.parse(compose);

      expect(parsed.services.service.networks['ci-os-hub_network']).toEqual({ gw_priority: 1 });
      expect(parsed.services.service.networks).not.toHaveProperty('ci-hub_network');
      expect(parsed.networks['ci-os-hub_network']).toEqual({ name: 'ci-os-hub_network', external: true });
      expect(parsed.networks).not.toHaveProperty('ci-hub_network');
    } finally {
      if (previousHubContainerName === undefined) delete process.env.HUB_CONTAINER_NAME;
      else process.env.HUB_CONTAINER_NAME = previousHubContainerName;
      if (previousRabbitmqHost === undefined) delete process.env.RABBITMQ_HOST;
      else process.env.RABBITMQ_HOST = previousRabbitmqHost;
    }
  });

  it('should correctly format deploy resources', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 80,
      deploy: {
        resources: {
          limits: { cpus: '0.50', memory: '50M', pids: 1 },
          reservations: { cpus: '0.25', memory: '20M', devices: [{ capabilities: ['gpu'], driver: 'nvidia', count: 'all' }] },
        },
      },
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);
    expect(compose).toMatchSnapshot();
  });

  it('should correctly format devices', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 80,
      // Ordinary passthroughs. `/dev/sda` used to be here, and the sandbox now
      // refuses it for an app with no grant — this test is about FORMATTING, so
      // the security case has its own vectors in `dynamic-compose.test.ts`.
      devices: ['/dev/ttyUSB0:/dev/ttyUSB0', '/dev/ttyACM0:/dev/xvda:rwm'],
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);
    expect(compose).toMatchSnapshot();
  });

  describe('app security sandbox', () => {
    it('rejects a privileged service from a non-allowlisted app', async () => {
      const service: ServiceInput = { name: 'svc', image: 'image', internalPort: 80, privileged: true };
      // `urn` is the nginx app (not in TRUSTED_APP_SECURITY_ALLOWLIST)
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('rejects a docker.sock host mount from a non-allowlisted app', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        internalPort: 80,
        volumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('rejects host network mode from a non-allowlisted app', async () => {
      const service: ServiceInput = { name: 'svc', image: 'image', internalPort: 80, networkMode: 'host' };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('refuses an allowlisted NAME from a store that is not the official one', async () => {
      /*
       * ⚠ THE GRANT USED TO BE KEYED ON THE BARE APP NAME. So any user-added
       * store — and `_user`, the custom-app path — could claim `privileged:
       * true` or a `/var/run/docker.sock` bind simply by naming its app
       * `home-assistant` or `netdata`. The allowlist is an audited set of holes
       * in the sandbox for specific, reviewed first-party apps; a name is not
       * evidence that this is one of them.
       *
       * `CI_MARKETPLACE_STORE_SLUG` is the same provenance signal
       * `isOfficialStoreApp` rests on: the store segment is recorded by the Hub
       * at install time and cannot be claimed by a manifest.
       */
      const impostor = createAppUrn('home-assistant', 'some-user-added-store');
      const service: ServiceInput = { name: 'homeassistant', image: 'image', internalPort: 8123, privileged: true };

      await expect(composeBuilder.getDockerCompose([service], {}, impostor, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('refuses an allowlisted name installed as a custom app', async () => {
      const custom = createAppUrn('netdata', '_user');
      const service: ServiceInput = {
        name: 'netdata',
        image: 'image',
        internalPort: 19999,
        volumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
      };

      await expect(composeBuilder.getDockerCompose([service], {}, custom, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('allows a privileged service from an allowlisted app (home-assistant)', async () => {
      const haUrn = createAppUrn('home-assistant', CI_MARKETPLACE_STORE_SLUG);
      const service: ServiceInput = { name: 'homeassistant', image: 'image', internalPort: 8123, privileged: true, networkMode: 'host' };
      await expect(composeBuilder.getDockerCompose([service], {}, haUrn, subnet)).resolves.toContain('privileged: true');
    });

    it('allows granted host-path binds from an allowlisted app (netdata) but not ungranted ones', async () => {
      const netdataUrn = createAppUrn('netdata', CI_MARKETPLACE_STORE_SLUG);
      const granted: ServiceInput = {
        name: 'netdata',
        image: 'image',
        internalPort: 19999,
        volumes: [{ hostPath: '/proc', containerPath: '/host/proc', readOnly: true }],
      };
      await expect(composeBuilder.getDockerCompose([granted], {}, netdataUrn, subnet)).resolves.toContain('services:');

      // A path netdata is NOT granted (e.g. /etc) must still be rejected.
      const ungranted: ServiceInput = {
        name: 'netdata',
        image: 'image',
        internalPort: 19999,
        volumes: [{ hostPath: '/etc/shadow', containerPath: '/host/etc/shadow' }],
      };
      await expect(composeBuilder.getDockerCompose([ungranted], {}, netdataUrn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('allows a docker.sock host mount for coder', async () => {
      const coderUrn = createAppUrn('coder', CI_MARKETPLACE_STORE_SLUG);
      const service: ServiceInput = {
        name: 'coder',
        image: 'image',
        internalPort: 7080,
        volumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, coderUrn, subnet)).resolves.toContain('services:');
    });

    it('allows a privileged sidecar service for duix-avatar', async () => {
      const duixUrn = createAppUrn('duix-avatar', CI_MARKETPLACE_STORE_SLUG);
      const main: ServiceInput = { name: 'duix-avatar', image: 'image', internalPort: 8383 };
      const sidecar: ServiceInput = { name: 'video-synthesis', image: 'image', internalPort: 8384, privileged: true };
      await expect(composeBuilder.getDockerCompose([main, sidecar], {}, duixUrn, subnet)).resolves.toContain('privileged: true');
    });

    it('allows granted host-path binds from an allowlisted app (falco) but not the rest of /sys', async () => {
      const falcoUrn = createAppUrn('falco', CI_MARKETPLACE_STORE_SLUG);
      const granted: ServiceInput = {
        name: 'falco',
        image: 'image',
        internalPort: 8765,
        volumes: [
          { hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' },
          { hostPath: '/sys/kernel/tracing', containerPath: '/sys/kernel/tracing' },
        ],
      };
      await expect(composeBuilder.getDockerCompose([granted], {}, falcoUrn, subnet)).resolves.toContain('services:');

      const ungranted: ServiceInput = {
        name: 'falco',
        image: 'image',
        internalPort: 8765,
        volumes: [{ hostPath: '/sys/module', containerPath: '/host/sys/module' }],
      };
      await expect(composeBuilder.getDockerCompose([ungranted], {}, falcoUrn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('allows NET_ADMIN and /dev/net/tun for the VPN apps (transmission-vpn, wg-easy) but not SYS_MODULE', async () => {
      const transmissionUrn = createAppUrn('transmission-vpn', CI_MARKETPLACE_STORE_SLUG);
      const transmission: ServiceInput = {
        name: 'transmission-vpn',
        image: 'image',
        internalPort: 9091,
        capAdd: ['NET_ADMIN'],
        devices: ['/dev/net/tun'],
      };
      await expect(composeBuilder.getDockerCompose([transmission], {}, transmissionUrn, subnet)).resolves.toContain('- NET_ADMIN');

      const wgEasyUrn = createAppUrn('wg-easy', CI_MARKETPLACE_STORE_SLUG);
      const wgEasy: ServiceInput = { name: 'wg-easy', image: 'image', internalPort: 51821, capAdd: ['NET_ADMIN'] };
      await expect(composeBuilder.getDockerCompose([wgEasy], {}, wgEasyUrn, subnet)).resolves.toContain('- NET_ADMIN');

      // Upstream's wg-easy compose also lists SYS_MODULE (kernel module loading); the grant stops at NET_ADMIN.
      const withSysModule: ServiceInput = { ...wgEasy, capAdd: ['NET_ADMIN', 'SYS_MODULE'] };
      await expect(composeBuilder.getDockerCompose([withSysModule], {}, wgEasyUrn, subnet)).rejects.toThrow(/host-privileged access/);

      // And NET_ADMIN is still a grant: the same manifest from a non-allowlisted app is refused.
      await expect(composeBuilder.getDockerCompose([wgEasy], {}, urn, subnet)).rejects.toThrow(/host-privileged access/);
    });

    it('allows a privileged sandbox service for refly', async () => {
      const reflyUrn = createAppUrn('refly', CI_MARKETPLACE_STORE_SLUG);
      const main: ServiceInput = { name: 'refly', image: 'image', internalPort: 5700 };
      const sandbox: ServiceInput = { name: 'refly-sandbox', image: 'image', internalPort: 5701, privileged: true };
      await expect(composeBuilder.getDockerCompose([main, sandbox], {}, reflyUrn, subnet)).resolves.toContain('privileged: true');
    });

    it('allows the benign /etc/localtime and /etc/timezone binds for any app', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        internalPort: 80,
        volumes: [
          { hostPath: '/etc/localtime', containerPath: '/etc/localtime', readOnly: true },
          { hostPath: '/etc/timezone', containerPath: '/etc/timezone', readOnly: true },
        ],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).resolves.toContain('services:');
    });

    // Compose's short syntax decides bind-vs-volume from the source's shape, so a path in the
    // volumeName slot renders as a host bind. The schema's charset rule only warns at this sink,
    // which would leave the volumeName field as an unchecked route to any host path.
    it('rejects a path-shaped volumeName, which compose would render as a host bind', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [{ volumeName: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' } as never],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow('CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
    });

    it('rejects a relative volumeName, which compose also treats as a bind source', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [{ volumeName: './host-dir', containerPath: '/data' } as never],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow('CUSTOM_APP_ERROR_VOLUME_NAME_INVALID');
    });

    // `network_mode: <name>` joins that network. The edge network holds the two hops Traefik trusts
    // to vouch for a client's address, so an app there could choose the address it appears as.
    it('refuses a network mode that names a Hub network, even for an app with the host-network grant', async () => {
      const homeAssistantUrn = createAppUrn('home-assistant', CI_MARKETPLACE_STORE_SLUG);
      for (const [appUrn, networkMode] of [
        [urn, 'ci-hub_edge'],
        [urn, 'ci-hub_internal'],
        [homeAssistantUrn, 'ci-hub_edge'],
      ] as const) {
        const service: ServiceInput = { name: 'svc', image: 'image', internalPort: 80, networkMode };
        const refusal = composeBuilder.getDockerCompose([service], {}, appUrn, subnet);
        await expect(refusal).rejects.toThrow('CUSTOM_APP_ERROR_NETWORK_MODE_NOT_ALLOWED');
        // Not grantable, so the operator is not sent to the allowlist.
        await expect(refusal).rejects.not.toThrow(/TRUSTED_APP_SECURITY_ALLOWLIST/);
      }

      const sidecar: ServiceInput = { name: 'sidecar', image: 'image', networkMode: 'service:svc' };
      const main: ServiceInput = { name: 'svc', image: 'image', internalPort: 80, isMain: true };
      await expect(composeBuilder.getDockerCompose([main, sidecar], {}, urn, subnet)).resolves.toContain('network_mode: service:svc');
    });

    it('still allows a legitimate named volume', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [{ volumeName: 'pgdata', containerPath: '/var/lib/postgresql' }],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, urn, subnet)).resolves.toContain('pgdata:/var/lib/postgresql');
    });
  });

  it('should correctly format entrypoint as string', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 80,
      entrypoint: 'entrypoint',
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);

    expect(compose).toMatchSnapshot();
  });

  it('should correctly format entrypoint as array', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 80,
      entrypoint: ['entrypoint', 'arg1', 'arg2'],
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);

    expect(compose).toMatchSnapshot();
  });

  it('should correctly format logging', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 80,
      logging: { driver: 'json-file', options: { 'syslog-address': 'tcp://192.168.0.42:123' } },
    };

    const compose = await composeBuilder.getDockerCompose([service], {}, urn, subnet);

    expect(compose).toMatchSnapshot();
  });

  it('should correctly interpolate RUNCIHUB_APP_ID in service labels', () => {
    const service = serviceBuilder
      .setName('service')
      .setImage('image')
      .setLabels({
        '{{RUNCIHUB_APP_ID}}.service': true,
        'com.docker.compose.service': '{{RUNCIHUB_APP_ID}}',
        '{{ RUNCIHUB_APP_ID }}': '{{ RUNCIHUB_APP_ID }}',
      })
      .interpolateVariables('my-test-app')
      .build();

    const compose = composeBuilder.addService(service).build();

    expect(compose).toMatchSnapshot();
  });

  it('should correctly format a complex docker-compose file', async () => {
    const service1: ServiceInput = {
      name: 'service1',
      image: 'image1',
      internalPort: 80,
      addPorts: [{ containerPort: 9091, hostPort: 3400 }],
      extraHosts: ['host1', 'host2'],
      ulimits: { nproc: 1024, nofile: 65536 },
      command: 'node index.js',
      volumes: [
        { hostPath: '/host/path', containerPath: '/container/path', readOnly: true },
        { hostPath: '/host/path2', containerPath: '/container/path2' },
      ],
      environment: [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'PORT', value: 80 },
        { key: 'SOME_VAR', value: 'value' },
      ],
      healthCheck: { test: 'curl -f http://localhost/ || exit 1', interval: '1m30s', timeout: '10s', retries: 3, startPeriod: '40s' },
      dependsOn: ['service2'],
      capAdd: ['SYS_ADMIN', 'NET_ADMIN'],
      deploy: {
        resources: {
          limits: { cpus: '0.50', memory: '50M', pids: 1 },
          reservations: { cpus: '0.25', memory: '20M', devices: [{ capabilities: ['gpu'], driver: 'nvidia', count: 'all' }] },
        },
      },
      hostname: 'hostname',
      devices: ['/dev/ttyUSB0:/dev/ttyUSB0', '/dev/sda:/dev/xvda:rwm'],
      entrypoint: ['entrypoint', 'arg1', 'arg2'],
      pid: '1',
      privileged: true,
      tty: true,
      user: 'user',
      workingDir: '/working/dir',
      shmSize: '1G',
      capDrop: ['SYS_ADMIN', 'NET_ADMIN'],
      logging: { driver: 'json-file', options: { 'syslog-address': 'tcp://192.168.0.42:123' } },
      readOnly: true,
      securityOpt: ['label=disable', 'label=role:ROLE'],
      stopSignal: 'SIGTERM',
      stopGracePeriod: '1m',
      stdinOpen: true,
    };

    const service2: ServiceInput = {
      name: 'service2',
      image: 'image2',
      internalPort: 443,
    };

    // service1 exercises privileged formatting, so run it under an app that is granted
    // privileged in TRUSTED_APP_SECURITY_ALLOWLIST (the sandbox rejects privileged otherwise).
    const complexUrn = createAppUrn('home-assistant', CI_MARKETPLACE_STORE_SLUG);
    const compose = await composeBuilder.getDockerCompose([service1, service2], {}, complexUrn, subnet);

    expect(compose).toMatchSnapshot();
  });

  it('should publish host port for cloudflare exposed apps even when openPort is false', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: true,
    };

    const compose = await composeBuilder.getDockerCompose(
      [service],
      { exposureMode: 'cloudflare', exposedLocal: true, openPort: false, port: 8080 },
      urn,
      subnet,
    );
    const yamlObject = yaml.parse(compose);

    expect(yamlObject.services.service.ports).toEqual(['${APP_PORT}:440']);
  });

  describe('named volumes', () => {
    const dbService = (extra: Partial<ServiceInput> = {}): ServiceInput => ({
      name: 'database',
      image: 'postgres:18',
      volumes: [{ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/postgresql', requiresPosixPermissions: true }],
      ...extra,
    });

    it('mounts a manifest-declared named volume and declares it at the top level', async () => {
      const service: ServiceInput = {
        name: 'service',
        image: 'image',
        volumes: [{ volumeName: 'pgdata', containerPath: '/var/lib/postgresql' }],
      };

      const yamlObject = yaml.parse(await composeBuilder.getDockerCompose([service], {}, urn, subnet));

      expect(yamlObject.services.service.volumes).toEqual(['pgdata:/var/lib/postgresql']);
      expect(yamlObject.volumes).toEqual({ pgdata: {} });
    });

    /** A Hub whose app-data filesystem cannot carry ownership — i.e. a Windows host path. */
    const permissionlessBuilder = () => new DockerComposeBuilder('ci.computer', 'ci.lan', false);

    it('keeps a bind mount when the filesystem carries POSIX permissions', async () => {
      const yamlObject = yaml.parse(await composeBuilder.getDockerCompose([dbService()], {}, urn, subnet));

      expect(yamlObject.services.database.volumes).toEqual(['${APP_DATA_DIR}/data/db:/var/lib/postgresql']);
      expect(yamlObject.volumes).toBeUndefined();
    });

    it('redirects an ownership-sensitive bind mount to a named volume when the filesystem cannot', async () => {
      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([dbService()], {}, urn, subnet));

      expect(yamlObject.services.database.volumes).toEqual(['data-db:/var/lib/postgresql']);
      expect(yamlObject.volumes).toEqual({ 'data-db': {} });
    });

    it('gives sidecars sharing a data directory the same volume so they still share data', async () => {
      const sidecar = dbService({ name: 'fix-permissions', image: 'busybox' });
      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([dbService(), sidecar], {}, urn, subnet));

      expect(yamlObject.services.database.volumes).toEqual(['data-db:/var/lib/postgresql']);
      expect(yamlObject.services['fix-permissions'].volumes).toEqual(['data-db:/var/lib/postgresql']);
      expect(yamlObject.volumes).toEqual({ 'data-db': {} });
    });

    it('gives two databases sharing a mount point distinct volumes', async () => {
      // fastgpt and postiz each run two postgres services, both mounting their own host directory
      // at `/var/lib/postgresql/data`. Naming the volume after the mount point would put both
      // servers — postiz' are different major versions — on one data directory.
      const pg = (name: string, dir: string): ServiceInput => ({
        name,
        image: 'postgres:18',
        volumes: [{ hostPath: `\${APP_DATA_DIR}/data/${dir}`, containerPath: '/var/lib/postgresql/data', requiresPosixPermissions: true }],
      });

      const yamlObject = yaml.parse(
        await permissionlessBuilder().getDockerCompose([pg('db', 'postgres'), pg('temporal-db', 'temporal-postgres')], {}, urn, subnet),
      );

      expect(yamlObject.services.db.volumes).toEqual(['data-postgres:/var/lib/postgresql/data']);
      expect(yamlObject.services['temporal-db'].volumes).toEqual(['data-temporal--postgres:/var/lib/postgresql/data']);
      expect(Object.keys(yamlObject.volumes).sort()).toEqual(['data-postgres', 'data-temporal--postgres']);
    });

    it('gives data directories that differ only by a hyphen distinct volumes', async () => {
      // `data/db` and `data-db` are unrelated directories; collapsing both onto `data-db` would
      // silently merge them into one volume.
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [
          { hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/a', requiresPosixPermissions: true },
          { hostPath: '${APP_DATA_DIR}/data-db', containerPath: '/b', requiresPosixPermissions: true },
        ],
      };

      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([service], {}, urn, subnet));

      expect(yamlObject.services.svc.volumes).toEqual(['data-db:/a', 'data--db:/b']);
      expect(Object.keys(yamlObject.volumes).sort()).toEqual(['data--db', 'data-db']);
    });

    it('keeps every derived name valid for docker and distinct across separator-like characters', async () => {
      // A trailing trim would re-merge exactly the paths the escaping above keeps apart, and a
      // leading `.` or `-` is not a legal docker volume name.
      const paths = ['${APP_DATA_DIR}/data/db', '${APP_DATA_DIR}/data-db', '${APP_DATA_DIR}/data_db', '${APP_DATA_DIR}/.cache'];
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: paths.map((hostPath, index) => ({ hostPath, containerPath: `/m${index}`, requiresPosixPermissions: true })),
      };

      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([service], {}, urn, subnet));
      const names = Object.keys(yamlObject.volumes);

      expect(names).toHaveLength(paths.length);
      for (const name of names) {
        expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
      }
    });

    it('resolves a trailing slash to the same volume, since it is the same directory', async () => {
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [
          { hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/a', requiresPosixPermissions: true },
          { hostPath: '${APP_DATA_DIR}/data/db/', containerPath: '/b', requiresPosixPermissions: true },
        ],
      };

      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([service], {}, urn, subnet));

      expect(Object.keys(yamlObject.volumes)).toEqual(['data-db']);
    });

    it('rejects two different directories that derive the same volume name', async () => {
      // `deriveVolumeName` is not injective for every host path: `/a-/b` and `/a/-b` both derive
      // `a---b`. Rendering them anyway would mount two unrelated directories on one volume and merge
      // their data. The build must fail loudly instead.
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [
          { hostPath: '${APP_DATA_DIR}/a-/b', containerPath: '/x', requiresPosixPermissions: true },
          { hostPath: '${APP_DATA_DIR}/a/-b', containerPath: '/y', requiresPosixPermissions: true },
        ],
      };

      await expect(permissionlessBuilder().getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/claimed by two different sources/);
    });

    it('rejects a redirected bind whose derived name collides with a declared volume', async () => {
      // A named volume declared as `data-db` and a redirected bind at `/data/db` (which also derives
      // `data-db`) would land on the same volume. Different sources, one name — reject it.
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [
          { volumeName: 'data-db', containerPath: '/x' },
          { hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/y', requiresPosixPermissions: true },
        ],
      };

      await expect(permissionlessBuilder().getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/claimed by two different sources/);
    });

    it('does not redirect a volume whose requiresPosixPermissions is a non-boolean', async () => {
      // The flag is only warn-validated at this sink, so a malformed `"false"` must not read as
      // truthy and redirect a bind the author never marked for it.
      const service: ServiceInput = {
        name: 'svc',
        image: 'image',
        volumes: [{ hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/x', requiresPosixPermissions: 'false' as never }],
      };

      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([service], {}, urn, subnet));

      expect(yamlObject.services.svc.volumes).toEqual(['${APP_DATA_DIR}/data/db:/x']);
      expect(yamlObject.volumes).toBeUndefined();
    });

    it('leaves bind mounts that do not need ownership alone on a permission-less filesystem', async () => {
      const service: ServiceInput = {
        name: 'service',
        image: 'image',
        volumes: [{ hostPath: '${APP_DATA_DIR}/data/media', containerPath: '/media' }],
      };

      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([service], {}, urn, subnet));

      expect(yamlObject.services.service.volumes).toEqual(['${APP_DATA_DIR}/data/media:/media']);
      expect(yamlObject.volumes).toBeUndefined();
    });
  });

  it('should add port mapping when openPort is enabled', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: true,
    };

    const compose = await composeBuilder.getDockerCompose([service], { openPort: true }, urn, subnet);
    const yamlObject = yaml.parse(compose);

    expect(yamlObject.services.service.ports).toBeDefined();
    expect(yamlObject.services.service.ports[0]).toBe('${APP_PORT}:440');
  });

  it('should only add default labels when service is not main', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: false,
    };

    const compose = await composeBuilder.getDockerCompose([service], { exposed: false, exposedLocal: false }, urn, subnet);
    const yamlObject = yaml.parse(compose);

    expect(yamlObject.services.service.labels).toEqual({
      'ci-hub.managed': true,
      'ci-hub.appurn': urn,
      'ci-os-hub.managed': true,
      'ci-os-hub.appurn': urn,
    });
  });

  it('should publish host port for local exposure mode even when openPort is false', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: true,
    };

    const compose = await composeBuilder.getDockerCompose(
      [service],
      { exposureMode: 'local', openPort: false, localSubdomain: 'myapp' },
      urn,
      subnet,
      'example.com',
      'ci.lan',
    );
    const yamlObject = yaml.parse(compose);

    expect(yamlObject.services.service.ports).toBeDefined();
    expect(yamlObject.services.service.ports[0]).toBe('${APP_PORT}:440');
    expect(yamlObject.services.service.labels['traefik.enable']).toBeUndefined();
  });

  describe('loopbackHostPort', () => {
    const main: ServiceInput = { name: 'service', image: 'image', internalPort: 18789, isMain: true };

    it('publishes the main port on loopback for every mode that binds a host port', async () => {
      const loopbackBuilder = new DockerComposeBuilder('ci.computer', 'ci.lan', true, { loopbackHostPort: true });
      for (const form of [
        { exposureMode: 'local' as const, openPort: false },
        { exposureMode: 'cloudflare' as const, exposedLocal: true, openPort: false },
        { exposureMode: 'tailscale' as const, openPort: true },
      ]) {
        const yamlObject = yaml.parse(await loopbackBuilder.getDockerCompose([main], form, urn, subnet));
        expect(yamlObject.services.service.ports, form.exposureMode).toEqual(['127.0.0.1:${APP_PORT}:18789']);
      }
    });

    it('still publishes nothing where no host port was asked for', async () => {
      const loopbackBuilder = new DockerComposeBuilder('ci.computer', 'ci.lan', true, { loopbackHostPort: true });
      const yamlObject = yaml.parse(await loopbackBuilder.getDockerCompose([main], { exposureMode: 'tailscale', openPort: false }, urn, subnet));

      expect(yamlObject.services.service.ports).toBeUndefined();
    });

    it('leaves the Traefik router in front of the container untouched', async () => {
      const form = { exposureMode: 'cloudflare' as const, exposedLocal: true, enableAuth: true };
      const plain = yaml.parse(await composeBuilder.getDockerCompose([main], form, urn, subnet, 'ci.computer', 'ci.lan', undefined, 'agent.origin'));
      const loopback = yaml.parse(
        await new DockerComposeBuilder('ci.computer', 'ci.lan', true, { loopbackHostPort: true }).getDockerCompose(
          [main],
          form,
          urn,
          subnet,
          'ci.computer',
          'ci.lan',
          undefined,
          'agent.origin',
        ),
      );

      expect(loopback.services.service.labels).toEqual(plain.services.service.labels);
      expect(loopback.services.service.labels['traefik.http.routers.nginx-store-id-insecure.middlewares']).toBe(
        'ci-hub-edge-headers@file,ci-hub@file,ci-hub-app-starting@file',
      );
    });

    it('binds every interface when the option is absent, as it always has', async () => {
      const yamlObject = yaml.parse(await composeBuilder.getDockerCompose([main], { exposureMode: 'local' }, urn, subnet));

      expect(yamlObject.services.service.ports).toEqual(['${APP_PORT}:18789']);
    });
  });

  it('should be able to parse a compose.json file', async () => {
    const composeJson: { services: ServiceInput[] } = {
      services: [
        {
          // @ts-expect-error testing extra fields
          something: 'crazy',
          name: 'ctfd',
          image: 'ctfd/ctfd:3.7.5',
          isMain: true,
          internalPort: 8000,
          environment: [
            { key: 'UPLOAD_FOLDER', value: '/var/uploads' },
            { key: 'DATABASE_URL', value: 'mysql+pymysql://cihub:${CTFD_MYSQL_DB_PASSWORD}@ctfd-db/ctfd' },
          ],
          dependsOn: ['ctfd-db'],
          volumes: [
            {
              hostPath: '${APP_DATA_DIR}/data/uploads',
              containerPath: '/var/log/CTFd',
            },
            {
              hostPath: '${APP_DATA_DIR}/data/uploads',
              containerPath: '/var/uploads',
            },
          ],
          extraLabels: {
            'some-label': 'some-value',
            '{{RUNCIHUB_APP_ID}}.service': true,
            'com.docker.compose.service': '{{RUNCIHUB_APP_ID}}',
            '{{ RUNCIHUB_APP_ID }}': '{{ RUNCIHUB_APP_ID }}',
          },
        },
        {
          name: 'ctfd-db',
          image: 'mariadb:10.4.12',
          internalPort: 3306,
          environment: [
            { key: 'MYSQL_ROOT_PASSWORD', value: '${CTFD_MYSQL_ROOT_PASSWORD}' },
            { key: 'MYSQL_USER', value: 'cihub' },
            { key: 'MYSQL_PASSWORD', value: '${CTFD_MYSQL_DB_PASSWORD}' },
            { key: 'MYSQL_DATABASE', value: 'ctfd' },
          ],
          volumes: [
            {
              hostPath: '${APP_DATA_DIR}/data/db',
              containerPath: '/var/lib/mysql',
            },
          ],
          command: ['mysqld', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--wait_timeout=28800', '--log-warnings=0'],
        },
        {
          name: 'ctfd-redis',
          image: 'redis:4',
          internalPort: 6379,
          volumes: [
            {
              hostPath: '${APP_DATA_DIR}/data/redis',
              containerPath: '/data',
            },
          ],
        },
      ],
    };

    const yaml = await composeBuilder.getDockerCompose(composeJson.services, { appId: 'test-app', openPort: true }, urn, subnet);

    expect(yaml).toMatchSnapshot();
  });
});

const mainService: ServiceInput = {
  name: 'nginx',
  image: 'nginx:latest',
  internalPort: 80,
  isMain: true,
};

describe('DockerComposeBuilder — public web hostname in Traefik labels', () => {
  let builder: DockerComposeBuilder;

  beforeEach(() => {
    builder = new DockerComposeBuilder('example.com', 'ci.lan');
  });

  it('uses the cloudflare origin hostname passed to getDockerCompose', async () => {
    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare' },
      urn,
      subnet,
      'example.com',
      'ci.lan',
      undefined,
      'myapp-dev1-org.ci.lan',
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id.rule'];

    expect(hostRule).toBe('Host(`myapp-dev1-org.ci.lan`)');
  });

  it('passes the public hostname to apps behind the cloudflare origin route', async () => {
    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare', enableAuth: true },
      urn,
      subnet,
      'example.com',
      'ci.lan',
      undefined,
      'myapp-dev1-org.ci.lan',
      'myapp-dev1-org.example.com',
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;

    expect(labels['traefik.http.middlewares.nginx-store-id-public-host.headers.customrequestheaders.X-Forwarded-Host']).toBe(
      'myapp-dev1-org.example.com',
    );
    expect(labels['traefik.http.routers.nginx-store-id-insecure.middlewares']).toBe(
      'ci-hub-edge-headers@file,ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
    );
  });

  describe('the Hub login on an open-port route', () => {
    /*
     * Until compose built the tunnel route for apps that also publish a host port, those apps had
     * no route at all. Many never chose a login: an API or MCP install of CI-OpenClaw that sends
     * `{ exposureMode: 'cloudflare' }` reaches the builder with the queue's `openPort: true` and no
     * `enableAuth`, and OpenClaw's `/` hands out its gateway token.
     */
    const routeMiddlewares = async (form: Record<string, unknown>) => {
      const result = await builder.getDockerCompose(
        [{ ...mainService, internalPort: 18789 }],
        form,
        urn,
        subnet,
        'ci.computer',
        'ci.lan',
        undefined,
        'openclaw-core-2-acme.ci.lan',
        'openclaw-core-2-acme.ci.computer',
      );
      const labels: Record<string, string> = yaml.parse(result).services.nginx.labels;
      return [labels['traefik.http.routers.nginx-store-id.middlewares'], labels['traefik.http.routers.nginx-store-id-insecure.middlewares']];
    };

    it('requires it when the form never decided', async () => {
      const middlewares = await routeMiddlewares({ exposureMode: 'cloudflare', openPort: true });

      expect(middlewares).toEqual([
        'ci-hub-edge-headers@file,ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
        'ci-hub-edge-headers@file,ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
      ]);
    });

    it('leaves it off when the operator turned it off', async () => {
      const middlewares = await routeMiddlewares({ exposureMode: 'cloudflare', openPort: true, enableAuth: false });

      expect(middlewares).toEqual([
        'ci-hub-edge-headers@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
        'ci-hub-edge-headers@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
      ]);
    });

    it('does not change a route that served without a host port before', async () => {
      const middlewares = await routeMiddlewares({ exposureMode: 'cloudflare', openPort: false });

      expect(middlewares).toEqual([
        'ci-hub-edge-headers@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
        'ci-hub-edge-headers@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
      ]);
    });
  });

  it('keeps the same origin hostname even when the public domain has multiple labels', async () => {
    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare' },
      urn,
      subnet,
      'my.lifescope.io',
      'ci.lan',
      undefined,
      'myapp-dev1-org.ci.lan',
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id.rule'];

    expect(hostRule).toBe('Host(`myapp-dev1-org.ci.lan`)');
  });
});

/*
 * CI-Hub#1764: while an app starts, Traefik answered its routers with a bare "Bad Gateway". Every
 * router an app container declares now ends with the Hub's "<app> is starting…" page, including the
 * ones a manifest writes or rewrites through `extraLabels`.
 */
describe('DockerComposeBuilder — the app-starting page on every app router', () => {
  const ORIGIN = 'nginx-hub1-acme.ci.lan';

  const labelsFor = async (form: Record<string, unknown>, services: ServiceInput[] = [mainService]) => {
    const result = await new DockerComposeBuilder('ci.computer', 'ci.lan').getDockerCompose(
      services,
      form,
      urn,
      subnet,
      'ci.computer',
      'ci.lan',
      undefined,
      ORIGIN,
      'nginx-hub1-acme.ci.computer',
    );
    return yaml.parse(result).services as Record<string, { labels: Record<string, string | boolean> }>;
  };

  it('keeps a manifest’s own chain, login included, when it replaces ours under the app-id placeholder', async () => {
    // Donetick's shape: the manifest names the router through `{{CI_HUB_APP_ID}}` and sets its chain.
    const services = await labelsFor({ exposureMode: 'cloudflare', enableAuth: true }, [
      {
        ...mainService,
        extraLabels: {
          'traefik.http.routers.{{CI_HUB_APP_ID}}.middlewares': 'ci-hub@file,{{CI_HUB_APP_ID}}-public-host@docker',
          'traefik.http.routers.{{CI_HUB_APP_ID}}-insecure.middlewares': 'ci-hub@file,{{CI_HUB_APP_ID}}-public-host@docker',
        },
      },
    ]);
    const labels = services.nginx?.labels ?? {};

    expect(labels['traefik.http.routers.nginx-store-id.middlewares']).toBe('ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file');
    expect(labels['traefik.http.routers.nginx-store-id-insecure.middlewares']).toBe(
      'ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
    );
    expect(Object.keys(labels).some((key) => key.includes('{{'))).toBe(false);
  });

  it('keeps our chain when a manifest only rewrites a router’s hosts', async () => {
    // Kimai's shape: the LAN host and the public host on the routers the builder made.
    const services = await labelsFor({ exposureMode: 'cloudflare', enableAuth: true }, [
      {
        ...mainService,
        extraLabels: {
          'traefik.http.routers.{{CI_HUB_APP_ID}}.rule': 'Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)',
          'traefik.http.routers.{{CI_HUB_APP_ID}}-insecure.rule': 'Host(`${APP_LOCAL_DOMAIN}`) || Host(`${APP_BASE_HOST}`)',
        },
      },
    ]);
    const labels = services.nginx?.labels ?? {};

    for (const router of ['nginx-store-id', 'nginx-store-id-insecure']) {
      expect(labels[`traefik.http.routers.${router}.middlewares`], router).toBe(
        'ci-hub-edge-headers@file,ci-hub@file,nginx-store-id-public-host@docker,ci-hub-app-starting@file',
      );
    }
    expect(Object.keys(labels).some((key) => key.includes('{{'))).toBe(false);
  });

  it('reaches a router a manifest declares on another service of the app', async () => {
    const services = await labelsFor({ exposureMode: 'cloudflare' }, [
      mainService,
      {
        name: 'admin',
        image: 'admin:latest',
        internalPort: 8080,
        extraLabels: {
          'traefik.enable': true,
          'traefik.http.routers.{{CI_HUB_APP_ID}}-admin.rule': 'Host(`admin.ci.lan`)',
          'traefik.http.routers.{{CI_HUB_APP_ID}}-admin.entrypoints': 'web',
        },
      },
    ]);

    expect(services.admin?.labels['traefik.http.routers.nginx-store-id-admin.middlewares']).toBe('ci-hub-app-starting@file');
  });

  it('covers the Private VPN router too', async () => {
    const services = await labelsFor({ exposureMode: 'tailscale' });

    expect(services.nginx?.labels['traefik.http.routers.nginx-store-id-tailscale.middlewares']).toBe('ci-hub-app-starting@file');
  });

  it('adds nothing to an app with no Traefik route: it is opened on its own port', async () => {
    const services = await labelsFor({ exposureMode: 'local' });

    expect(Object.keys(services.nginx?.labels ?? {}).filter((key) => key.startsWith('traefik.http.routers.'))).toEqual([]);
  });
});

describe('DockerComposeBuilder resource limits', () => {
  let builder: DockerComposeBuilder;

  const service: ServiceInput = {
    name: 'nginx',
    image: 'nginx:latest',
    internalPort: 80,
    isMain: true,
  };

  beforeEach(() => {
    builder = new DockerComposeBuilder('example.com', 'ci.lan');
  });

  const build = (form: Parameters<DockerComposeBuilder['getDockerCompose']>[1], services = [service], defaults?: { cpu?: string; memory?: string }) =>
    builder.getDockerCompose(services, form, urn, subnet, 'example.com', 'ci.lan', undefined, undefined, undefined, defaults?.cpu, defaults?.memory);

  it('does not stamp auto-allocated defaults onto every service', async () => {
    const compose = await build({}, [service], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy).toBeUndefined();
  });

  it('applies user-set form limits when the app defines none', async () => {
    const compose = await build({ cpuLimit: '2', memoryLimit: '2048M' }, [service], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy.resources.limits).toEqual({ cpus: '2', memory: '2048M' });
  });

  it('never overrides limits the app defines itself', async () => {
    const limitedService: ServiceInput = {
      ...service,
      deploy: { resources: { limits: { cpus: '0.5', memory: '256M' } } },
    };
    const compose = await build({}, [limitedService], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy.resources.limits).toEqual({ cpus: '0.5', memory: '256M' });
  });

  it('fills only the missing limit from the form, not from auto defaults', async () => {
    const cpuOnlyService: ServiceInput = {
      ...service,
      deploy: { resources: { limits: { cpus: '0.5' } } },
    };
    const compose = await build({ memoryLimit: '2048M' }, [cpuOnlyService], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy.resources.limits).toEqual({ cpus: '0.5', memory: '2048M' });
  });

  it('adds no deploy section when there are no limits at all', async () => {
    const compose = await build({});
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy).toBeUndefined();
  });
});

describe('DockerComposeBuilder network sandboxing and defense-in-depth', () => {
  let builder: DockerComposeBuilder;

  beforeEach(() => {
    builder = new DockerComposeBuilder('example.com', 'ci.lan');
  });

  it('adds security_opt: ["no-new-privileges:true"] when configured via setSecurityOpt', async () => {
    builder.setSecurityOpt(['no-new-privileges:true']);

    const service: ServiceInput = {
      name: 'web',
      image: 'nginx:alpine',
      internalPort: 80,
    };

    const compose = await builder.getDockerCompose([service], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    expect(parsed.services.web.security_opt).toEqual(['no-new-privileges:true']);
  });

  it('merges container security_opt with service-declared options without duplicates', async () => {
    builder.setSecurityOpt(['no-new-privileges:true']);

    const service: ServiceInput = {
      name: 'web',
      image: 'nginx:alpine',
      internalPort: 80,
      securityOpt: ['apparmor:my-profile', 'no-new-privileges:true'],
    };

    const compose = await builder.getDockerCompose([service], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    expect(parsed.services.web.security_opt).toEqual(['apparmor:my-profile', 'no-new-privileges:true']);
  });

  it('provides network isolation to block internal infrastructure hosts and ports', async () => {
    builder.setNetworkIsolation({
      isolateInternalInfrastructure: true,
      blockInternalHosts: true,
    });

    const service: ServiceInput = {
      name: 'web',
      image: 'nginx:alpine',
      internalPort: 80,
    };

    const compose = await builder.getDockerCompose([service], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    // Extra hosts should contain 127.0.0.1 null-routes for internal infrastructure
    expect(parsed.services.web.extra_hosts).toContain('ci-hub-db:127.0.0.1');
    expect(parsed.services.web.extra_hosts).toContain('ci-hub-queue:127.0.0.1');
    expect(parsed.services.web.extra_hosts).toContain('postgres:127.0.0.1');
    expect(parsed.services.web.extra_hosts).toContain('rabbitmq:127.0.0.1');

    // Automatically includes no-new-privileges when isolation is active
    expect(parsed.services.web.security_opt).toContain('no-new-privileges:true');
  });

  it('rejects containers binding directly to Postgres port 6543 under network isolation', async () => {
    builder.setNetworkIsolation(true);

    const service: ServiceInput = {
      name: 'malicious-postgres-connect',
      image: 'alpine:latest',
      internalPort: 6543,
    };

    await expect(builder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/cannot bind to internal infrastructure port 6543/);
  });

  it('rejects containers binding directly to RabbitMQ port 5672 under network isolation', async () => {
    builder.setNetworkIsolation(true);

    const service: ServiceInput = {
      name: 'malicious-rabbitmq-connect',
      image: 'alpine:latest',
      internalPort: 5672,
    };

    await expect(builder.getDockerCompose([service], {}, urn, subnet)).rejects.toThrow(/cannot bind to internal infrastructure port 5672/);
  });

  it('supports internal: true and disableMainNetwork for complete network isolation', async () => {
    builder.setNetworkIsolation({
      internal: true,
      disableMainNetwork: true,
    });

    const service: ServiceInput = {
      name: 'isolated-service',
      image: 'alpine:latest',
      isMain: true,
    };

    const compose = await builder.getDockerCompose([service], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    // App network should have internal: true
    expect(parsed.networks['nginx_store-id_network'].internal).toBe(true);

    // Main hub networks should not be included
    expect(parsed.networks['ci-hub_network']).toBeUndefined();
    expect(parsed.networks['ci-os-hub_network']).toBeUndefined();
    expect(parsed.services['isolated-service'].networks['ci-hub_network']).toBeUndefined();
  });

  it('accepts options object via constructor and getDockerCompose', async () => {
    const customBuilder = new DockerComposeBuilder('example.com', 'ci.lan', true, {
      securityOpt: ['no-new-privileges:true'],
      networkIsolation: {
        blockInternalHosts: true,
      },
    });

    const service: ServiceInput = {
      name: 'web',
      image: 'nginx:alpine',
      internalPort: 80,
    };

    const compose = await customBuilder.getDockerCompose([service], {}, urn, subnet);
    const parsed = yaml.parse(compose);

    expect(parsed.services.web.security_opt).toContain('no-new-privileges:true');
    expect(parsed.services.web.extra_hosts).toContain('ci-hub-db:127.0.0.1');
  });
});
