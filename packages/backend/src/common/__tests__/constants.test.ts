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
    expect(constants.DEFAULT_PUBLIC_DOMAIN).toBe('companionintelligence.org');
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
