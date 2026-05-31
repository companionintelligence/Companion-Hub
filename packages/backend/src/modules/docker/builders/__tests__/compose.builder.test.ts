/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: intended */
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { ServiceInput } from '@ci-hub/common/schemas';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    const compose = await composeBuilder.getDockerCompose([service1, service2], {}, urn, subnet);

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

// Helper: write a temp env file and return its path
async function writeTempEnvFile(content: string): Promise<string> {
  const path = join(tmpdir(), `compose-test-${Date.now()}.env`);
  await writeFile(path, content, 'utf-8');
  return path;
}

const mainService: ServiceInput = {
  name: 'nginx',
  image: 'nginx:latest',
  internalPort: 80,
  isMain: true,
};

describe('DockerComposeBuilder — public domain resolution from env file', () => {
  let builder: DockerComposeBuilder;
  let envFilePath: string;

  beforeEach(() => {
    builder = new DockerComposeBuilder('example.com', 'ci.lan');
  });

  afterEach(async () => {
    if (envFilePath) {
      await unlink(envFilePath).catch(() => {});
    }
  });

  it('(1) new install: APP_PUBLIC_DOMAIN present — uses it as domain, derives correct subdomain', async () => {
    envFilePath = await writeTempEnvFile('APP_PUBLIC_HOSTNAME=myapp-dev1-org.example.com\nAPP_PUBLIC_DOMAIN=example.com\n');

    const result = await builder.getDockerCompose([mainService], { exposureMode: 'cloudflare' }, urn, subnet, 'example.com', 'ci.lan', envFilePath);
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id-local.rule'];

    expect(hostRule).toBe('Host(`myapp-dev1-org.example.com`)');
  });

  it('(2) old install: APP_PUBLIC_DOMAIN absent — form.publicDomain used as fallback', async () => {
    envFilePath = await writeTempEnvFile('APP_PUBLIC_HOSTNAME=myapp-dev1-org.example.com\n');

    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare', publicDomain: 'example.com' },
      urn,
      subnet,
      'example.com',
      'ci.lan',
      envFilePath,
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id-local.rule'];

    expect(hostRule).toBe('Host(`myapp-dev1-org.example.com`)');
  });

  it('(3) multi-label domain: slice(-2) heuristic would truncate — form.publicDomain preserves full domain', async () => {
    // Without APP_PUBLIC_DOMAIN, slice(-2) of 'myapp-dev1-org.my.lifescope.io'
    // would give 'lifescope.io' — wrong. form.publicDomain corrects this.
    envFilePath = await writeTempEnvFile('APP_PUBLIC_HOSTNAME=myapp-dev1-org.my.lifescope.io\n');

    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare', publicDomain: 'my.lifescope.io' },
      urn,
      subnet,
      'my.lifescope.io',
      'ci.lan',
      envFilePath,
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id-local.rule'];

    // Subdomain should be just 'myapp-dev1-org', domain 'my.lifescope.io'
    expect(hostRule).toBe('Host(`myapp-dev1-org.my.lifescope.io`)');
    expect(hostRule).not.toContain('lifescope.io.my.lifescope.io');
  });

  it('(4) multi-label domain: APP_PUBLIC_DOMAIN present — used directly, no heuristic needed', async () => {
    envFilePath = await writeTempEnvFile('APP_PUBLIC_HOSTNAME=myapp-dev1-org.my.lifescope.io\nAPP_PUBLIC_DOMAIN=my.lifescope.io\n');

    const result = await builder.getDockerCompose(
      [mainService],
      { exposureMode: 'cloudflare' },
      urn,
      subnet,
      'my.lifescope.io',
      'ci.lan',
      envFilePath,
    );
    const parsed = yaml.parse(result);
    const labels: Record<string, string> = parsed.services.nginx.labels;
    const hostRule = labels['traefik.http.routers.nginx-store-id-local.rule'];

    expect(hostRule).toBe('Host(`myapp-dev1-org.my.lifescope.io`)');
  });
});
