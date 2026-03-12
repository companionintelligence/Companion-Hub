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

  it('should NOT add port mapping when exposedLocal is enabled but openPort is false', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: true,
    };

    const compose = await composeBuilder.getDockerCompose([service], { exposedLocal: true, openPort: false, port: 8080 }, urn, subnet);
    const yamlObject = yaml.parse(compose);

    // Ports should not be exposed when exposedLocal=true but openPort=false
    // Traefik uses Docker internal networking and doesn't need host port mapping
    expect(yamlObject.services.service.ports).toBeUndefined();
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

  it('should only add default labels when service is not exposed', async () => {
    const service: ServiceInput = {
      name: 'service',
      image: 'image',
      internalPort: 440,
      isMain: true,
    };

    const compose = await composeBuilder.getDockerCompose([service], { exposed: false, exposedLocal: false }, urn, subnet);
    const yamlObject = yaml.parse(compose);

    expect(yamlObject.services.service.labels).toEqual({ 'ci-os-hub.managed': true, 'ci-os-hub.appurn': urn });
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
