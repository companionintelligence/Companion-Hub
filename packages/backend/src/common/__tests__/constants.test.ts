import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const savedEnv = {
  API_PORT: process.env.API_PORT,
  CI_HUB_ENVIRONMENT: process.env.CI_HUB_ENVIRONMENT,
  HUB_CONTAINER_NAME: process.env.HUB_CONTAINER_NAME,
  NODE_ENV: process.env.NODE_ENV,
  RABBITMQ_HOST: process.env.RABBITMQ_HOST,
};

async function loadConstants() {
  vi.resetModules();
  return import('../constants');
}

afterEach(() => {
  if (savedEnv.API_PORT === undefined) delete process.env.API_PORT;
  else process.env.API_PORT = savedEnv.API_PORT;

  if (savedEnv.CI_HUB_ENVIRONMENT === undefined) delete process.env.CI_HUB_ENVIRONMENT;
  else process.env.CI_HUB_ENVIRONMENT = savedEnv.CI_HUB_ENVIRONMENT;

  if (savedEnv.HUB_CONTAINER_NAME === undefined) delete process.env.HUB_CONTAINER_NAME;
  else process.env.HUB_CONTAINER_NAME = savedEnv.HUB_CONTAINER_NAME;

  if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv.NODE_ENV;

  if (savedEnv.RABBITMQ_HOST === undefined) delete process.env.RABBITMQ_HOST;
  else process.env.RABBITMQ_HOST = savedEnv.RABBITMQ_HOST;
});

describe('constants environment defaults', () => {
  it('uses production defaults only when CI_HUB_ENVIRONMENT is production', async () => {
    process.env.CI_HUB_ENVIRONMENT = 'production';
    process.env.NODE_ENV = 'development';

    const constants = await loadConstants();

    expect(constants.DEFAULT_CI_CLOUD_URL).toBe('https://hub.ci.computer');
    // Dev and prod share the same canonical public-domain default; per-env
    // working domain comes from Companion Portal registration / sync validation.
    expect(constants.DEFAULT_PUBLIC_DOMAIN).toBe('companionintelligence.com');
    expect(constants.DEFAULT_DEV_PUBLIC_DOMAIN).toBe(constants.DEFAULT_PROD_PUBLIC_DOMAIN);
  });

  it('does not switch to production defaults when only NODE_ENV is production', async () => {
    delete process.env.CI_HUB_ENVIRONMENT;
    process.env.NODE_ENV = 'production';

    const constants = await loadConstants();

    expect(constants.DEFAULT_CI_CLOUD_URL).toBe('https://hub.companionintelligence.com');
    expect(constants.DEFAULT_PUBLIC_DOMAIN).toBe('companionintelligence.com');
  });

  it('keeps non-production environments on development defaults', async () => {
    process.env.CI_HUB_ENVIRONMENT = 'staging';
    process.env.NODE_ENV = 'production';

    const constants = await loadConstants();

    expect(constants.DEFAULT_CI_CLOUD_URL).toBe('https://hub.companionintelligence.com');
    expect(constants.DEFAULT_PUBLIC_DOMAIN).toBe('companionintelligence.com');
  });
});

describe('resolveDataDir', () => {
  const inContainer = () => true;
  const onHost = () => false;

  it('prefers an explicit data dir over everything else', async () => {
    const { resolveDataDir } = await loadConstants();

    expect(resolveDataDir({ CI_HUB_DATA_DIR: '/tmp/ci-hub-e2e', ROOT_FOLDER_HOST: '/repo/.internal' }, inContainer)).toBe('/tmp/ci-hub-e2e');
    expect(resolveDataDir({ CIHUB_DATA_DIR: '/legacy/data' }, inContainer)).toBe('/legacy/data');
    // TIPI_DATA_DIR is the legacy name appliances actually set; #1143 renamed it to the
    // never-shipped CIHUB_DATA_DIR by substring, so this fell through to ROOT_FOLDER_HOST.
    expect(resolveDataDir({ TIPI_DATA_DIR: '/legacy/tipi-data' }, inContainer)).toBe('/legacy/tipi-data');
    expect(resolveDataDir({ TIPI_DATA_DIR: '/legacy/tipi-data', ROOT_FOLDER_HOST: '/repo/.internal' }, inContainer)).toBe('/legacy/tipi-data');
    // The current name still wins over both legacy spellings.
    expect(resolveDataDir({ CI_HUB_DATA_DIR: '/current', TIPI_DATA_DIR: '/legacy/tipi-data', CIHUB_DATA_DIR: '/legacy/data' }, inContainer)).toBe(
      '/current',
    );
  });

  it('uses the container mount even though ROOT_FOLDER_HOST is set in the container', async () => {
    const { resolveDataDir } = await loadConstants();

    expect(resolveDataDir({ ROOT_FOLDER_HOST: '/home/user/ci-hub/.internal' }, inContainer)).toBe('/data');
  });

  it('falls back to ROOT_FOLDER_HOST on a host instead of the unwritable /data', async () => {
    const { resolveDataDir } = await loadConstants();

    expect(resolveDataDir({ ROOT_FOLDER_HOST: '/home/user/ci-hub/.internal' }, onHost)).toBe('/home/user/ci-hub/.internal');
  });

  it('never returns /data on a host, even with no env at all', async () => {
    const { resolveDataDir } = await loadConstants();

    // Bare `turbo run dev`: turbo does not feed .env files to tasks, so NODE_ENV and
    // ROOT_FOLDER_HOST are both absent. Returning /data here is the EACCES boot crash.
    expect(resolveDataDir({}, onHost)).toBe(path.join(os.homedir(), '.ci-hub'));
  });
});

describe('Hub Docker topology names', () => {
  it('defaults to canonical names for current installs', async () => {
    const { hubAppNetworkNames, hubContainerName, hubNetworkName, hubQueueName } = await loadConstants();

    expect(hubContainerName({})).toBe('ci-hub');
    expect(hubQueueName({})).toBe('ci-hub-queue');
    expect(hubNetworkName({})).toBe('ci-hub_network');
    expect(hubAppNetworkNames({})).toEqual(['ci-hub_network', 'ci-os-hub_network']);
  });

  it('keeps image-only updates on the legacy topology until compose migrates', async () => {
    const { hubAppNetworkNames, hubContainerName, hubNetworkName, hubQueueName } = await loadConstants();
    const legacyComposeEnv = { RABBITMQ_HOST: 'ci-os-hub-queue' };

    expect(hubContainerName(legacyComposeEnv)).toBe('ci-os-hub');
    expect(hubQueueName(legacyComposeEnv)).toBe('ci-os-hub-queue');
    expect(hubNetworkName(legacyComposeEnv)).toBe('ci-os-hub_network');
    expect(hubAppNetworkNames(legacyComposeEnv)).toEqual(['ci-os-hub_network']);
  });

  it('lets the canonical compose marker override legacy persisted queue settings', async () => {
    const { hubContainerName, hubNetworkName, hubQueueName } = await loadConstants();
    const migratedComposeEnv = {
      HUB_CONTAINER_NAME: 'ci-hub',
      RABBITMQ_HOST: 'ci-os-hub-queue',
    };

    expect(hubContainerName(migratedComposeEnv)).toBe('ci-hub');
    expect(hubQueueName(migratedComposeEnv)).toBe('ci-hub-queue');
    expect(hubNetworkName(migratedComposeEnv)).toBe('ci-hub_network');
  });

  it('uses legacy forward auth DNS and the actual API port under the old compose', async () => {
    delete process.env.HUB_CONTAINER_NAME;
    process.env.RABBITMQ_HOST = 'ci-os-hub-queue';
    process.env.API_PORT = '5002';

    const { DEFAULT_FORWARD_AUTH_URL } = await loadConstants();

    expect(DEFAULT_FORWARD_AUTH_URL).toBe('http://ci-os-hub:5002/api/auth/traefik');
  });
});
