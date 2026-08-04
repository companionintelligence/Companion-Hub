/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: intended */
import { createAppUrn } from '@/common/helpers/app-helpers';
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
      devices: ['/dev/ttyUSB0:/dev/ttyUSB0', '/dev/sda:/dev/xvda:rwm'],
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

    it('allows a privileged service from an allowlisted app (home-assistant)', async () => {
      const haUrn = createAppUrn('home-assistant', 'store-id');
      const service: ServiceInput = { name: 'homeassistant', image: 'image', internalPort: 8123, privileged: true, networkMode: 'host' };
      await expect(composeBuilder.getDockerCompose([service], {}, haUrn, subnet)).resolves.toContain('privileged: true');
    });

    it('allows granted host-path binds from an allowlisted app (netdata) but not ungranted ones', async () => {
      const netdataUrn = createAppUrn('netdata', 'store-id');
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
      const coderUrn = createAppUrn('coder', 'store-id');
      const service: ServiceInput = {
        name: 'coder',
        image: 'image',
        internalPort: 7080,
        volumes: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }],
      };
      await expect(composeBuilder.getDockerCompose([service], {}, coderUrn, subnet)).resolves.toContain('services:');
    });

    it('allows a privileged sidecar service for duix-avatar', async () => {
      const duixUrn = createAppUrn('duix-avatar', 'store-id');
      const main: ServiceInput = { name: 'duix-avatar', image: 'image', internalPort: 8383 };
      const sidecar: ServiceInput = { name: 'video-synthesis', image: 'image', internalPort: 8384, privileged: true };
      await expect(composeBuilder.getDockerCompose([main, sidecar], {}, duixUrn, subnet)).resolves.toContain('privileged: true');
    });

    it('allows granted host-path binds from an allowlisted app (falco) but not the rest of /sys', async () => {
      const falcoUrn = createAppUrn('falco', 'store-id');
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

    it('allows a privileged sandbox service for refly', async () => {
      const reflyUrn = createAppUrn('refly', 'store-id');
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

  it('should correctly interpolate RUNTIPI_APP_ID in service labels', () => {
    const service = serviceBuilder
      .setName('service')
      .setImage('image')
      .setLabels({
        '{{RUNTIPI_APP_ID}}.service': true,
        'com.docker.compose.service': '{{RUNTIPI_APP_ID}}',
        '{{ RUNTIPI_APP_ID }}': '{{ RUNTIPI_APP_ID }}',
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
    const complexUrn = createAppUrn('home-assistant', 'store-id');
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

      expect(yamlObject.services.database.volumes).toEqual(['var-lib-postgresql:/var/lib/postgresql']);
      expect(yamlObject.volumes).toEqual({ 'var-lib-postgresql': {} });
    });

    it('gives sidecars sharing a mount point the same volume so they still share data', async () => {
      const sidecar = dbService({ name: 'fix-permissions', image: 'busybox' });
      const yamlObject = yaml.parse(await permissionlessBuilder().getDockerCompose([dbService(), sidecar], {}, urn, subnet));

      expect(yamlObject.services.database.volumes).toEqual(['var-lib-postgresql:/var/lib/postgresql']);
      expect(yamlObject.services['fix-permissions'].volumes).toEqual(['var-lib-postgresql:/var/lib/postgresql']);
      expect(yamlObject.volumes).toEqual({ 'var-lib-postgresql': {} });
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

    expect(yamlObject.services.service.labels).toEqual({ 'ci-os-hub.managed': true, 'ci-os-hub.appurn': urn });
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
            { key: 'DATABASE_URL', value: 'mysql+pymysql://tipi:${CTFD_MYSQL_DB_PASSWORD}@ctfd-db/ctfd' },
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
            '{{RUNTIPI_APP_ID}}.service': true,
            'com.docker.compose.service': '{{RUNTIPI_APP_ID}}',
            '{{ RUNTIPI_APP_ID }}': '{{ RUNTIPI_APP_ID }}',
          },
        },
        {
          name: 'ctfd-db',
          image: 'mariadb:10.4.12',
          internalPort: 3306,
          environment: [
            { key: 'MYSQL_ROOT_PASSWORD', value: '${CTFD_MYSQL_ROOT_PASSWORD}' },
            { key: 'MYSQL_USER', value: 'tipi' },
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
    builder.getDockerCompose(services, form, urn, subnet, 'example.com', 'ci.lan', undefined, undefined, defaults?.cpu, defaults?.memory);

  it('applies default cpu and memory limits when the app defines none', async () => {
    const compose = await build({}, [service], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy.resources.limits).toEqual({ cpus: '4', memory: '4096M' });
  });

  it('prefers form limits over defaults', async () => {
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

  it('fills only the missing limit when the app defines the other', async () => {
    const cpuOnlyService: ServiceInput = {
      ...service,
      deploy: { resources: { limits: { cpus: '0.5' } } },
    };
    const compose = await build({}, [cpuOnlyService], { cpu: '4', memory: '4096M' });
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy.resources.limits).toEqual({ cpus: '0.5', memory: '4096M' });
  });

  it('adds no deploy section when there are no limits at all', async () => {
    const compose = await build({});
    const parsed = yaml.parse(compose);

    expect(parsed.services.nginx.deploy).toBeUndefined();
  });
});
