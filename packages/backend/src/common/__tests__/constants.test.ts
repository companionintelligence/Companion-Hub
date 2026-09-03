import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const savedEnv = {
  CI_HUB_ENVIRONMENT: process.env.CI_HUB_ENVIRONMENT,
  NODE_ENV: process.env.NODE_ENV,
};

async function loadConstants() {
  vi.resetModules();
  return import('../constants');
}

describe('constants environment defaults', () => {
  afterEach(() => {
    if (savedEnv.CI_HUB_ENVIRONMENT === undefined) delete process.env.CI_HUB_ENVIRONMENT;
    else process.env.CI_HUB_ENVIRONMENT = savedEnv.CI_HUB_ENVIRONMENT;

    if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.NODE_ENV;
  });

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
